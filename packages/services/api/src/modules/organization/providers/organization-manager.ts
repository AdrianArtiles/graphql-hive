import { Injectable, Scope } from 'graphql-modules';
import { paramCase } from 'param-case';
import { Organization, OrganizationType } from '../../../shared/entities';
import { HiveError } from '../../../shared/errors';
import { AuthManager } from '../../auth/providers/auth-manager';
import { Logger } from '../../shared/providers/logger';
import { Storage } from '../../shared/providers/storage';
import type { OrganizationSelector } from '../../shared/providers/storage';
import { share, cache, uuid, diffArrays, pushIfMissing } from '../../../shared/helpers';
import { MessageBus } from '../../shared/providers/message-bus';
import { ActivityManager } from '../../activity/providers/activity-manager';
import { BillingProvider } from '../../billing/providers/billing.provider';
import { TokenStorage } from '../../token/providers/token-storage';
import { Tracking } from '../../shared/providers/tracking';
import { OrganizationAccessScope } from '../../auth/providers/organization-access';
import { ProjectAccessScope } from '../../auth/providers/project-access';
import { TargetAccessScope } from '../../auth/providers/target-access';
import { EnsurePersonalOrganizationEventPayload, ENSURE_PERSONAL_ORGANIZATION_EVENT } from './events';

const reservedNames = [
  'registry',
  'server',
  'usage',
  'graphql',
  'api',
  'auth',
  'home',
  'register',
  'login',
  'logout',
  'signup',
  'signin',
  'signout',
  'sign-up',
  'sign-in',
  'sign-out',
  'manage',
  'admin',
  'stats',
  'internal',
  'general',
  'dashboard',
  'index',
  'contact',
  'docs',
  'documentation',
  'help',
  'support',
  'faq',
  'knowledge',
  'internal',
];

/**
 * Responsible for auth checks.
 * Talks to Storage.
 */
@Injectable({
  scope: Scope.Operation,
  global: true,
})
export class OrganizationManager {
  private logger: Logger;

  constructor(
    logger: Logger,
    private storage: Storage,
    private authManager: AuthManager,
    private tokenStorage: TokenStorage,
    private messageBus: MessageBus,
    private activityManager: ActivityManager,
    private tracking: Tracking,
    private billingProvider: BillingProvider
  ) {
    this.logger = logger.child({ source: 'OrganizationManager' });
    this.messageBus.on<EnsurePersonalOrganizationEventPayload>(ENSURE_PERSONAL_ORGANIZATION_EVENT, data =>
      this.ensurePersonalOrganization(data)
    );
  }

  getOrganizationFromToken: () => Promise<Organization | never> = share(async () => {
    const token = this.authManager.ensureApiToken();
    const result = await this.tokenStorage.getToken({ token });

    await this.authManager.ensureOrganizationAccess({
      organization: result.organization,
      scope: OrganizationAccessScope.READ,
    });

    return this.storage.getOrganization({
      organization: result.organization,
    });
  });

  getOrganizationIdByToken: () => Promise<string | never> = share(async () => {
    const token = this.authManager.ensureApiToken();
    const { organization } = await this.tokenStorage.getToken({
      token,
    });

    return organization;
  });

  async getOrganization(selector: OrganizationSelector): Promise<Organization> {
    this.logger.debug('Fetching organization (selector=%o)', selector);
    await this.authManager.ensureOrganizationAccess({
      ...selector,
      scope: OrganizationAccessScope.READ,
    });
    return this.storage.getOrganization(selector);
  }

  async getOrganizations(): Promise<readonly Organization[]> {
    this.logger.debug('Fetching organizations');
    const user = await this.authManager.getCurrentUser();
    return this.storage.getOrganizations({ user: user.id });
  }

  async getOrganizationByInviteCode({ code }: { code: string }): Promise<Organization | { message: string } | never> {
    this.logger.debug('Fetching organization (inviteCode=%s)', code);
    const organization = await this.storage.getOrganizationByInviteCode({
      inviteCode: code,
    });

    if (!organization) {
      return {
        message: 'Invitation expired',
      };
    }

    const hasAccess = await this.authManager.checkOrganizationAccess({
      organization: organization.id,
      scope: OrganizationAccessScope.READ,
    });

    if (hasAccess) {
      return {
        message: "You're already a member",
      };
    }

    return organization;
  }

  @cache((selector: OrganizationSelector) => selector.organization)
  async getOrganizationMembers(selector: OrganizationSelector) {
    return this.storage.getOrganizationMembers(selector);
  }

  async getOrganizationMember(selector: OrganizationSelector & { user: string }) {
    return this.storage.getOrganizationMember(selector);
  }

  async getOrganizationOwner(selector: OrganizationSelector) {
    return this.storage.getOrganizationOwner(selector);
  }

  async createOrganization(input: {
    name: string;
    type: OrganizationType;
    user: {
      id: string;
      externalAuthUserId: string;
    };
  }): Promise<Organization> {
    const { name, type, user } = input;
    this.logger.info('Creating an organization (input=%o)', input);
    let cleanId = paramCase(name);

    if (reservedNames.includes(cleanId) || (await this.storage.getOrganizationByCleanId({ cleanId }))) {
      cleanId = paramCase(`${name}-${uuid(4)}`);
    }

    const organization = await this.storage.createOrganization({
      name,
      cleanId,
      type,
      user: user.id,
      scopes: [
        ...Object.values(OrganizationAccessScope),
        ...Object.values(ProjectAccessScope),
        ...Object.values(TargetAccessScope),
      ],
    });

    await this.activityManager.create({
      type: 'ORGANIZATION_CREATED',
      selector: {
        organization: organization.id,
      },
      user,
    });

    return organization;
  }

  async deleteOrganization(selector: OrganizationSelector): Promise<Organization> {
    this.logger.info('Deleting an organization (organization=%s)', selector.organization);
    await this.authManager.ensureOrganizationAccess({
      organization: selector.organization,
      scope: OrganizationAccessScope.DELETE,
    });

    const organization = await this.getOrganization({
      organization: selector.organization,
    });

    if (organization.type === OrganizationType.PERSONAL) {
      throw new HiveError(`Cannot remove a personal organization`);
    }

    await this.tracking.track({
      event: 'ORGANIZATION_DELETED',
      data: {
        ...selector,
        name: organization.name,
      },
    });

    const [deletedOrganization] = await Promise.all([
      this.storage.deleteOrganization({
        organization: organization.id,
      }),
      this.tokenStorage.invalidateOrganization({
        organization: selector.organization,
      }),
    ]);

    // Because we checked the access before, it's stale by now
    this.authManager.resetAccessCache();

    return deletedOrganization;
  }

  async updatePlan(
    input: {
      plan: string;
    } & OrganizationSelector
  ): Promise<Organization> {
    const { plan } = input;
    this.logger.info('Updating an organization plan (input=%o)', input);
    await this.authManager.ensureOrganizationAccess({
      ...input,
      scope: OrganizationAccessScope.SETTINGS,
    });
    const organization = await this.getOrganization({
      organization: input.organization,
    });

    const result = await this.storage.updateOrganizationPlan({
      billingPlan: plan,
      organization: organization.id,
    });

    await this.activityManager.create({
      type: 'ORGANIZATION_PLAN_UPDATED',
      selector: {
        organization: organization.id,
      },
      meta: {
        newPlan: plan,
        previousPlan: organization.billingPlan,
      },
    });

    return result;
  }

  async updateRateLimits(input: Pick<Organization, 'monthlyRateLimit'> & OrganizationSelector): Promise<Organization> {
    const { monthlyRateLimit } = input;
    this.logger.info('Updating an organization plan (input=%o)', input);
    await this.authManager.ensureOrganizationAccess({
      ...input,
      scope: OrganizationAccessScope.SETTINGS,
    });
    const organization = await this.getOrganization({
      organization: input.organization,
    });

    const result = await this.storage.updateOrganizationRateLimits({
      monthlyRateLimit,
      organization: organization.id,
    });

    if (this.billingProvider.enabled) {
      await this.billingProvider.syncOrganization({
        organizationId: organization.id,
        reserved: {
          operations: Math.floor(input.monthlyRateLimit.operations / 1_000_000),
          schemaPushes: input.monthlyRateLimit.schemaPush,
        },
      });
    }

    return result;
  }

  async updateName(
    input: {
      name: string;
    } & OrganizationSelector
  ): Promise<Organization> {
    const { name } = input;
    this.logger.info('Updating an organization name (input=%o)', input);
    await this.authManager.ensureOrganizationAccess({
      ...input,
      scope: OrganizationAccessScope.SETTINGS,
    });
    const [user, organization] = await Promise.all([
      this.authManager.getCurrentUser(),
      this.getOrganization({
        organization: input.organization,
      }),
    ]);

    if (organization.type === OrganizationType.PERSONAL) {
      throw new HiveError(`Cannot rename a personal organization`);
    }

    const result = await this.storage.updateOrganizationName({
      name,
      organization: organization.id,
      user: user.id,
    });

    await this.activityManager.create({
      type: 'ORGANIZATION_NAME_UPDATED',
      selector: {
        organization: organization.id,
      },
      meta: {
        value: result.name,
      },
    });

    return result;
  }

  async joinOrganization({ code }: { code: string }): Promise<Organization | { message: string }> {
    this.logger.info('Joining an organization (code=%s)', code);
    const organization = await this.getOrganizationByInviteCode({
      code,
    });

    if ('message' in organization) {
      return organization;
    }

    if (organization.type === OrganizationType.PERSONAL) {
      throw new HiveError(`Cannot join a personal organization`);
    }

    const user = await this.authManager.getCurrentUser();

    await this.storage.addOrganizationMember({
      user: user.id,
      organization: organization.id,
      scopes: [
        OrganizationAccessScope.READ,
        ProjectAccessScope.READ,
        ProjectAccessScope.OPERATIONS_STORE_READ,
        TargetAccessScope.READ,
        TargetAccessScope.REGISTRY_READ,
      ],
    });

    // Because we checked the access before, it's stale by now
    this.authManager.resetAccessCache();

    await this.activityManager.create({
      type: 'MEMBER_ADDED',
      selector: {
        organization: organization.id,
        user: user.id,
      },
    });

    return this.storage.getOrganization({
      organization: organization.id,
    });
  }

  async deleteMembers(
    selector: {
      users: readonly string[];
    } & OrganizationSelector
  ): Promise<Organization> {
    this.logger.info('Deleting a member from an organization (selector=%o)', selector);
    await this.authManager.ensureOrganizationAccess({
      ...selector,
      scope: OrganizationAccessScope.MEMBERS,
    });
    const owner = await this.getOrganizationOwner(selector);
    const { users, organization } = selector;

    if (users.some(user => user === owner.id)) {
      throw new HiveError(`Cannot remove the owner from the organization`);
    }

    const members = await this.storage.getOrganizationMembers({
      organization,
    });

    await this.storage.deleteOrganizationMembers({
      users,
      organization,
    });

    await Promise.all(
      users.map(user => {
        const member = members.find(m => m.id === user);

        if (member) {
          return this.activityManager.create({
            type: 'MEMBER_DELETED',
            selector: {
              organization,
            },
            meta: {
              email: member.user.email,
            },
          });
        }
      })
    );

    // Because we checked the access before, it's stale by now
    this.authManager.resetAccessCache();

    return this.storage.getOrganization({
      organization,
    });
  }

  async updateMemberAccess(
    input: {
      user: string;
      organizationScopes: readonly OrganizationAccessScope[];
      projectScopes: readonly ProjectAccessScope[];
      targetScopes: readonly TargetAccessScope[];
    } & OrganizationSelector
  ) {
    this.logger.info('Updating a member access in an organization (input=%o)', input);
    await this.authManager.ensureOrganizationAccess({
      ...input,
      scope: OrganizationAccessScope.MEMBERS,
    });

    const currentUser = await this.authManager.getCurrentUser();

    const [currentMember, member] = await Promise.all([
      this.getOrganizationMember({
        organization: input.organization,
        user: currentUser.id,
      }),
      this.getOrganizationMember({
        organization: input.organization,
        user: input.user,
      }),
    ]);

    const newScopes = [...input.organizationScopes, ...input.projectScopes, ...input.targetScopes];

    // See what scopes were removed or added
    const modifiedScopes = diffArrays(member.scopes, newScopes);

    // Check if the current user has rights to update these member scopes
    // User can't manage other user's scope if he's missing the scope as well
    const currentUserMissingScopes = modifiedScopes.filter(scope => !currentMember.scopes.includes(scope));

    if (currentUserMissingScopes.length > 0) {
      this.logger.debug(`Logged user scopes: %o`, currentMember.scopes);
      throw new HiveError(`No access to modify the scopes: ${currentUserMissingScopes.join(', ')}`);
    }

    // Ensure user still has read-only access
    pushIfMissing(newScopes, TargetAccessScope.READ);
    pushIfMissing(newScopes, ProjectAccessScope.READ);
    pushIfMissing(newScopes, OrganizationAccessScope.READ);

    // Update the scopes
    await this.storage.updateOrganizationMemberAccess({
      organization: input.organization,
      user: input.user,
      scopes: newScopes,
    });

    // Because we checked the access before, it's stale by now
    this.authManager.resetAccessCache();

    return this.storage.getOrganization({
      organization: input.organization,
    });
  }

  async resetInviteCode(selector: OrganizationSelector) {
    this.logger.info('Resetting an organization invite code (selector=%o)', selector);
    await this.authManager.ensureOrganizationAccess({
      ...selector,
      scope: OrganizationAccessScope.MEMBERS,
    });
    return this.storage.updateOrganizationInviteCode({
      organization: selector.organization,
      inviteCode: Math.random().toString(16).substr(2, 10),
    });
  }

  async ensurePersonalOrganization(payload: EnsurePersonalOrganizationEventPayload) {
    const myOrg = await this.storage.getMyOrganization({
      user: payload.user.id,
    });

    if (!myOrg) {
      this.logger.info('Detected missing personal organization (user=%s)', payload.user.id);
      await this.createOrganization({
        name: payload.name,
        user: payload.user,
        type: OrganizationType.PERSONAL,
      });
    }
  }
}

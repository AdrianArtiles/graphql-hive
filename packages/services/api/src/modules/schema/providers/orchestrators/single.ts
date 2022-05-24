import { Injectable, Inject } from 'graphql-modules';
import { parse } from 'graphql';
import { Logger } from '../../../shared/providers/logger';
import { HiveError } from '../../../../shared/errors';
import { Orchestrator, ProjectType, SchemaObject } from '../../../../shared/entities';
import { SchemaBuildError } from './errors';
import { SCHEMA_SERVICE_CONFIG } from './tokens';
import type { SchemaServiceConfig } from './tokens';
import { sentry } from '../../../../shared/sentry';
import { createTRPCClient } from '@trpc/client';
import { fetch } from 'cross-undici-fetch';
import type { SchemaBuilderApi } from '@hive/schema';

@Injectable()
export class SingleOrchestrator implements Orchestrator {
  type = ProjectType.SINGLE;
  private logger: Logger;
  private schemaService;

  constructor(logger: Logger, @Inject(SCHEMA_SERVICE_CONFIG) serviceConfig: SchemaServiceConfig) {
    this.logger = logger.child({ service: 'SingleOrchestrator' });
    this.schemaService = createTRPCClient<SchemaBuilderApi>({
      url: `${serviceConfig.endpoint}/trpc`,
      fetch,
    });
  }

  ensureConfig() {}

  @sentry('SingleOrchestrator.validate')
  async validate(schemas: SchemaObject[]) {
    this.logger.debug('Validating Single Schema');
    if (schemas.length > 1) {
      this.logger.debug('More than one schema (sources=%o)', {
        sources: schemas.map(s => s.source),
      });
      throw new HiveError('too many schemas');
    }

    const result = await this.schemaService.mutation('validate', {
      type: 'single',
      schemas: schemas.map(s => ({
        raw: s.raw,
        source: s.source,
      })),
    });

    return result.errors;
  }

  @sentry('SingleOrchestrator.build')
  async build(schemas: SchemaObject[]) {
    try {
      if (schemas.length > 1) {
        this.logger.error('More than one schema (sources=%o)', {
          sources: schemas.map(s => s.source),
        });
        throw new HiveError('too many schemas');
      }

      const result = await this.schemaService.mutation('build', {
        type: 'single',
        schemas: schemas.map(s => ({
          raw: s.raw,
          source: s.source,
        })),
      });

      return {
        document: parse(result.raw),
        raw: result.raw,
        source: result.source,
      };
    } catch (error) {
      throw new SchemaBuildError(error as Error);
    }
  }

  async supergraph() {
    return null;
  }
}

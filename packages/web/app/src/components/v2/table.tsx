import { ComponentProps, ReactElement } from 'react';
import clsx from 'clsx';

function Table({ children, className, ...props }: ComponentProps<'table'>): ReactElement {
  return (
    <table className={clsx('w-full', className)} {...props}>
      {children}
    </table>
  );
}

function TBody({ children, ...props }: ComponentProps<'tbody'>): ReactElement {
  return <tbody {...props}>{children}</tbody>;
}

function THead({ children, ...props }: ComponentProps<'thead'>): ReactElement {
  return (
    <thead {...props}>
      <tr>{children}</tr>
    </thead>
  );
}

function TFoot({ children, ...props }: ComponentProps<'tfoot'>): ReactElement {
  return (
    <tfoot {...props}>
      <tr className="text-gray-500">{children}</tr>
    </tfoot>
  );
}

function Th({ children, className, align = 'left', ...props }: ComponentProps<'th'>): ReactElement {
  return (
    <th className={clsx('px-5 py-4', className)} align={align} {...props}>
      {children}
    </th>
  );
}

function Tr({ children, className, ...props }: ComponentProps<'tr'>): ReactElement {
  return (
    <tr
      className={clsx('border border-gray-600/10 text-xs odd:bg-gray-600/10', className)}
      {...props}
    >
      {children}
    </tr>
  );
}

function Td({ children, className, ...props }: ComponentProps<'td'>): ReactElement {
  return (
    <td
      className={clsx(
        'break-all px-5 py-4 text-sm',
        className,
        // column.align === 'right' && 'text-right',
        // column.width === 'auto' && 'w-1',
      )}
      {...props}
    >
      {children}
    </td>
  );
}

export { Table, TBody, THead, TFoot, Th, Td, Tr };

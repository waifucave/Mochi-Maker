/**
 * Generates `generated.ts`, the typed method layer (agent API design 2.1): one method per command,
 * grouped by area (`tx.rig.addBinding(args)`), with the command's summary and documentation as
 * TSDoc. `test/generated.test.ts` checks that the committed file is current; run it with
 * UPDATE_GENERATED=1 to rewrite the file after changing commands.
 */
import { COMMANDS } from '@mochi-maker/core';

const comment = (lines: string[], indent: string) =>
  [
    `${indent}/**`,
    ...lines.map((l) => (l === '' ? `${indent} *` : `${indent} * ${l.replace(/\*\//g, '*\\/')}`)),
    `${indent} */`,
  ].join('\n');

export function generateMethodLayer(): string {
  const areas = new Map<string, string[]>();
  for (const name of [...COMMANDS.keys()].sort()) {
    const [area, verb] = name.split('.') as [string, string];
    areas.set(area, [...(areas.get(area) ?? []), verb]);
  }
  const out: string[] = [
    '// Generated from the command registry by packages/api/src/codegen.ts. Do not edit:',
    '// run `UPDATE_GENERATED=1 npx vitest run packages/api/test/generated.test.ts` instead.',
    "import type { ArgsOf, ResultOf } from '@mochi-maker/core';",
    '',
    '/** One typed method per command, grouped by area. */',
    'export interface CommandMethods {',
  ];
  for (const [area, verbs] of areas) {
    out.push(`  ${area}: {`);
    for (const verb of verbs) {
      const name = `${area}.${verb}`;
      const c = COMMANDS.get(name)!;
      out.push(
        comment(
          [
            c.summary,
            '',
            ...c.doc.split('\n'),
            '',
            `Command \`${name}\`.`,
            `Errors: ${c.errors.join(', ') || 'none'}.`,
          ],
          '    ',
        ),
      );
      out.push(`    ${verb}(args: ArgsOf<'${name}'>): ResultOf<'${name}'>;`);
    }
    out.push('  };');
  }
  out.push('}', '', '/** The areas and their verbs, for building the methods at run time. */');
  out.push('export const COMMAND_AREAS = {');
  for (const [area, verbs] of areas)
    out.push(`  ${area}: [${verbs.map((v) => `'${v}'`).join(', ')}],`);
  out.push('} as const;', '');
  return out.join('\n');
}

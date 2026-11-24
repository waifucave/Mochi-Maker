export declare const RELEASE_FILES: string[];

export declare function tagProblems(input: {
  start: string | undefined;
  tag: string;
  tagSha: string | null;
  sha: string;
}): string[];

export declare function cleanupPlan(input: {
  start: string | undefined;
  tag: string;
  sha: string;
  release: { draft: boolean; tag_name: string } | null;
  tagSha: string | null;
}): { release: boolean; tag: boolean };

export declare const steps: Record<
  'draft' | 'files' | 'publish' | 'verify' | 'remove' | 'cleanup',
  (env: Record<string, string | undefined>, log: (line: string) => void) => Promise<void>
>;

export declare const releaseTitle: (version: string, start: string, tag: string) => string;

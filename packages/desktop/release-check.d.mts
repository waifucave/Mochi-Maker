export declare function releaseProblems(input: {
  version: string;
  changelog: string;
  tag?: string | undefined;
  start?: 'tag' | 'dispatch' | undefined;
  ref?: string;
  tagExists?: boolean;
  releases?: { draft: boolean }[];
}): string[];

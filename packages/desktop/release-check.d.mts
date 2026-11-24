export declare function releaseProblems(input: {
  version: string;
  changelog: string;
  tag?: string | undefined;
  start?: 'tag' | 'dispatch' | 'rehearsal' | undefined;
  ref?: string;
  tagExists?: boolean;
  releases?: { draft: boolean }[];
  rehearsal?: string;
  isPrivate?: boolean;
  releaseToo?: boolean;
}): string[];

export declare const rehearsalTag: (runNumber: string | number) => string;
export declare const REHEARSAL_TAG: RegExp;

export declare function startOf(
  env: Record<string, string | undefined>,
): 'tag' | 'dispatch' | 'rehearsal' | undefined;

// Types for the tests that import scripts/mutation-unmeasured.mjs.

export interface Cast {
  line: number;
  column: number;
  end: { line: number; column: number };
  sites: number;
  text: string;
}

export interface Position {
  line: number;
  column: number;
}

export interface Measured {
  files: number;
  casts: number;
  sites: number;
  inside: number;
  rows: { file: string; line: number; sites: number; text: string; mutants: number }[];
}

export type Sources = Record<string, { source: string; mutants?: { location: { start: Position; end: Position } }[] | undefined }>;

export declare const LEFT: number;
export declare function castsOf(source: string): Cast[];
export declare function measure(files: Sources): Measured;
export declare function verdict(measured: Measured, left?: number): { passed: boolean; lines: string[]; message: string | null };
export declare function mutatedSources(patterns: string[], root?: string): Sources;

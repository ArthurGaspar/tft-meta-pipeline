/** Types and loaders for the JSON that run.py publishes to public/data. */

export type Kind = "comp" | "champion" | "item" | "augment" | "trait";
export type Tier = "S" | "A" | "B" | "C" | "D";

export interface Entry {
  id: string;
  name: string;
  icon: string | null;
  games: number;
  playRate: number;
  avgPlacement: number;
  top4Rate: number;
  winRate: number;
  score: number;
  tier: Tier | null;
  cost?: number;
  carry?: string;
}

export type TierLists = Record<string, Record<Kind, Entry[]>>;

export interface Change {
  kind: "champion" | "item" | "trait";
  id: string;
  name: string;
  icon: string | null;
  from: string;
  to: string;
  before: number;
  after: number;
  delta: number;
  z: number;
  significant: boolean;
}

export interface Build {
  id: string;
  name: string;
  icon: string | null;
  games: number;
  avgPlacement: number;
  score: number;
}

export interface Meta {
  generatedAt: string;
  set: number;
  patches: string[];
  matches: number;
  boards: Record<string, number>;
  method: { priorGames: number; minGames: number; tiers: [Tier, number][]; zSignificant: number };
}

interface FunctionStats {
  invocations: number;
  errors: number;
  coldStarts: number;
  durationMs: number;
  billedMs: number;
  gbSeconds: number;
}

export interface Pipeline {
  functions: Record<string, FunctionStats>;
  deadLetters: { function: string; attempts: number; error: string }[];
  s3: { requests: Record<string, number>; bytesStored: number };
  cost: { lambdaUsd: number; s3RequestsUsd: number; s3StoragePerMonthUsd: number; rdsPerMonthUsd: number; note: string };
  stack: { stack: string; region: string; deployedAt: string; resources: Record<string, { type: string; physicalId: string; status: string }> };
  quality: { quarantined: number; reasons: Record<string, number> };
  rawFiles: number;
  wallSeconds: number;
}

interface TruthPoint {
  id: string;
  name: string;
  power: number;
  score: number;
  tier: Tier;
}

export interface TruthCheck {
  patches: Record<string, Record<"champion" | "item" | "augment", { entities: number; spearman: number | null; points: TruthPoint[] }>>;
  changes: Record<string, { trueChanges: number; flagged: number; flaggedAndReal: number; rightDirection: number; missed: string[] }>;
}

const cache = new Map<string, Promise<unknown>>();

export function load<T>(name: string): Promise<T> {
  if (!cache.has(name)) {
    const url = `${import.meta.env.BASE_URL}data/${name}`;
    cache.set(
      name,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url} answered ${r.status}. Run \`python run.py\` to generate the data.`);
        return r.json();
      }),
    );
  }
  return cache.get(name) as Promise<T>;
}

export const KIND_LABEL: Record<Kind, string> = {
  comp: "Comps",
  champion: "Champions",
  item: "Items",
  augment: "Augments",
  trait: "Traits",
};

export const TIERS: Tier[] = ["S", "A", "B", "C", "D"];

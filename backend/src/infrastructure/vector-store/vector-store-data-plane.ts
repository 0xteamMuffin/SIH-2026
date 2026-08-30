export type VectorPointId = string | number;

export type VectorPayloadValue = null | boolean | number | string | VectorPayloadValue[] | { [key: string]: VectorPayloadValue };
export type VectorPayload = Record<string, VectorPayloadValue>;

export type VectorWriteScope = {
  workspaceId: string;
  scopeKey: string;
};

export type DataClassification = "PUBLIC" | "SYNTHETIC" | "INTERNAL" | "CONFIDENTIAL";

export type NamedVectorPoint = {
  id: VectorPointId;
  vector: number[];
  knowledgeSourceId: string;
  artifactId: string;
  classification: DataClassification;
  payload?: VectorPayload;
};

export type UpsertVectorPointsInput = {
  collectionName: string;
  vectorName: string;
  scope: VectorWriteScope;
  points: NamedVectorPoint[];
};

export type QueryVectorPointsInput = {
  collectionName: string;
  vectorName: string;
  vector: number[];
  permittedScopeKeys: string[];
  artifactIds?: string[];
  classifications?: DataClassification[];
  limit?: number;
  scoreThreshold?: number;
};

export type VectorQueryMatch = {
  id: VectorPointId;
  score: number;
  payload: VectorPayload;
};

export type DeleteKnowledgeSourceInput = {
  collectionName: string;
  knowledgeSourceId: string;
};

export type ReconciliationSelector = {
  scope?: VectorWriteScope;
  knowledgeSourceId?: string;
};

export type CountVectorPointsInput = ReconciliationSelector & {
  collectionName: string;
  exact?: boolean;
};

export type ScrollVectorPointsInput = ReconciliationSelector & {
  collectionName: string;
  cursor?: VectorPointId;
  limit?: number;
};

export type ScrolledVectorPoint = {
  id: VectorPointId;
  payload: VectorPayload;
};

export type VectorScrollPage = {
  points: ScrolledVectorPoint[];
  nextCursor?: VectorPointId;
};

export interface VectorStoreDataPlane {
  upsertPoints(input: UpsertVectorPointsInput): Promise<void>;
  queryPoints(input: QueryVectorPointsInput): Promise<VectorQueryMatch[]>;
  deleteByKnowledgeSourceId(input: DeleteKnowledgeSourceInput): Promise<void>;
  countPoints(input: CountVectorPointsInput): Promise<number>;
  scrollPoints(input: ScrollVectorPointsInput): Promise<VectorScrollPage>;
}

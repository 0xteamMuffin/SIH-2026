export type DenseVectorDistance = "cosine" | "euclid" | "dot" | "manhattan";

export type CollectionReference = {
  collectionName: string;
};

export type DenseCollectionDefinition = CollectionReference & {
  vector: {
    name: string;
    size: number;
    distance: DenseVectorDistance;
  };
};

export type PayloadIndexType = "keyword" | "integer" | "float" | "geo" | "text" | "bool" | "datetime" | "uuid";

export type PayloadIndexDefinition = {
  fieldName: string;
  type: PayloadIndexType;
};

export type CollectionValidation = {
  valid: boolean;
  mismatches: string[];
};

export interface VectorStoreAdmin {
  isReady(): Promise<boolean>;
  collectionExists(input: CollectionReference): Promise<boolean>;
  createCollection(input: DenseCollectionDefinition): Promise<void>;
  validateCollection(input: DenseCollectionDefinition): Promise<CollectionValidation>;
  createPayloadIndex(input: CollectionReference & { index: PayloadIndexDefinition }): Promise<void>;
  ensurePayloadIndexes(input: CollectionReference & { indexes: PayloadIndexDefinition[] }): Promise<void>;
}

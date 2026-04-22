export interface KnowledgeRow {
  id: string;
  title: string;
  type: string;
  importance: number;
  body: string;
  tags: string;
  source: string;
  status: string;
  created: string;
  last_accessed: string | null;
  access_count: number;
  feedback_rating: string | null;
  feedback_comment: string | null;
  feedback_at: string | null;
  feedback_consumed: number;
  rowid?: number;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  type: string;
  importance: number;
  body: string;
  tags: string[];
  source: string;
  status: string;
  created: string;
  last_accessed?: string;
  access_count: number;
}

export interface SearchResult {
  id: string;
  title: string;
  type: string;
  importance: number;
  tags: string[];
  source: string;
  score: number;
  snippet: string;
}

export interface WriteEntry {
  action: 'create' | 'update' | 'reinforce' | 'deprecate' | 'delete';
  id: string;
  title?: string;
  type?: string;
  importance?: number;
  body?: string;
  tags?: string[] | string;
  source?: string;
  status?: string;
  created?: string;
  last_accessed?: string;
  access_count?: number;
}

export interface WriteResult {
  id: string;
  action: string;
  result: string;
  error?: string;
}

export interface SearchOptions {
  tags?: string | string[];
  type?: string;
  minImportance?: number;
  limit?: number;
  status?: string | null;
}

export interface KnowledgeStats {
  initialized: boolean;
  message?: string;
  total?: number;
  archived?: number;
  byType?: Array<{ type: string; count: number }>;
  avgImportance?: number;
  dbSize?: number;
}

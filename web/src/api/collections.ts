import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from './client';
import type { MediaItem } from './media';

// Data layer for the collections browse pages (server routes/collections.ts).
// Mirrors the server's SerializedCollection / CollectionDetail shapes. The
// server already scopes every response to what the caller may see (visibility +
// parental filter + 404 cloak), so these hooks are thin.

/** The safe browse projection of a collection (mirrors SerializedCollection). */
export interface Collection {
  id: string;
  name: string;
  sortName: string;
  overview: string | null;
  /** "manual" (admin-curated) or "tmdb" (auto-linked from TMDB). */
  source: string;
  tmdbCollectionId: number | null;
  /** How many members the caller can actually access. */
  itemCount: number;
  /** The app's artwork route for the poster (`/api/...`), or null. */
  posterUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A collection plus its accessible members serialized in curated order. */
export interface CollectionDetail {
  collection: Collection;
  items: MediaItem[];
}

/** GET /api/collections — collections visible to the caller. */
export function getCollections(): Promise<Collection[]> {
  return apiRequest<{ collections: Collection[] }>('/collections').then(
    (response) => response.collections,
  );
}

/** GET /api/collections/:id — one collection with its accessible members. */
export function getCollection(id: string): Promise<CollectionDetail> {
  return apiRequest<CollectionDetail>(`/collections/${encodeURIComponent(id)}`);
}

export const collectionKeys = {
  all: ['collections'] as const,
  detail: (id: string) => ['collections', 'detail', id] as const,
};

/** All collections visible to the current user (browse grid). */
export function useCollections(): UseQueryResult<Collection[]> {
  return useQuery({ queryKey: collectionKeys.all, queryFn: getCollections });
}

/** One collection's detail (member grid). Disabled for an empty id. */
export function useCollection(id: string): UseQueryResult<CollectionDetail> {
  return useQuery({
    queryKey: collectionKeys.detail(id),
    queryFn: () => getCollection(id),
    enabled: id !== '',
  });
}

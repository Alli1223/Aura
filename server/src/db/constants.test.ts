import { describe, expect, it } from 'vitest';

import {
  LIBRARY_TYPES,
  MEDIA_FILE_STATUSES,
  MEDIA_ITEM_TYPES,
  STREAM_TYPES,
  USER_ROLES,
  libraryTypeSchema,
  mediaFileStatusSchema,
  mediaItemTypeSchema,
  streamTypeSchema,
  userRoleSchema,
} from './constants.js';

const cases = [
  { name: 'user roles', values: USER_ROLES, schema: userRoleSchema },
  { name: 'library types', values: LIBRARY_TYPES, schema: libraryTypeSchema },
  { name: 'media item types', values: MEDIA_ITEM_TYPES, schema: mediaItemTypeSchema },
  { name: 'media file statuses', values: MEDIA_FILE_STATUSES, schema: mediaFileStatusSchema },
  { name: 'stream types', values: STREAM_TYPES, schema: streamTypeSchema },
] as const;

describe.each(cases)('$name', ({ values, schema }) => {
  it('accepts every allowed value', () => {
    for (const value of values) {
      expect(schema.parse(value)).toBe(value);
    }
  });

  it('rejects values outside the union', () => {
    expect(schema.safeParse('not-a-real-value').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });
});

it('expected library types match the roadmap defaults', () => {
  expect(LIBRARY_TYPES).toEqual(['movies', 'tv', 'anime', 'recordings', 'other']);
});

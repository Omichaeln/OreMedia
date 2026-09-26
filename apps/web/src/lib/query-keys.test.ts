import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { createClient, createOptionsProxy } from './trpc';

const client = createClient({ url: 'http://127.0.0.1:1/trpc', pathname: () => '/' });
const queryClient = new QueryClient();
const keyOf = (tenantId: string | null) =>
  createOptionsProxy(client, queryClient, tenantId).brand.list.queryKey();

describe('query keys carry the company (a switch never reads another company’s cache)', () => {
  it('prefixes a company’s keys with its tenant id, so two companies never share a key', () => {
    expect(keyOf('ten_a')[0]).toEqual(['ten_a']);
    expect(keyOf('ten_a')).not.toEqual(keyOf('ten_b'));
  });

  it('leaves keys outside a company unprefixed', () => {
    expect(keyOf(null)[0]).toEqual(['brand', 'list']);
  });

  it('a company’s path filter matches only its own entries', () => {
    const a = createOptionsProxy(client, queryClient, 'ten_a');
    queryClient.setQueryData(a.brand.list.queryKey(), []);
    queryClient.setQueryData(createOptionsProxy(client, queryClient, 'ten_b').brand.list.queryKey(), []);
    expect(queryClient.getQueryCache().findAll(a.brand.pathFilter())).toHaveLength(1);
  });
});

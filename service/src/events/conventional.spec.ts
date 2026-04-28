import { parseConventional, normaliseScope } from './conventional';

describe('parseConventional', () => {
  it('parses type + scope + subject', () => {
    const cc = parseConventional('feat(api): add new endpoint');
    expect(cc.type).toBe('feat');
    expect(cc.scope).toBe('api');
    expect(cc.subject).toBe('add new endpoint');
    expect(cc.breaking).toBe(false);
  });

  it('parses scope-less commits', () => {
    const cc = parseConventional('fix: nil pointer in handler');
    expect(cc.type).toBe('fix');
    expect(cc.scope).toBeNull();
    expect(cc.subject).toBe('nil pointer in handler');
  });

  it('treats trailing ! as breaking', () => {
    const cc = parseConventional('feat(api)!: change return type');
    expect(cc.breaking).toBe(true);
  });

  it('captures BREAKING CHANGE footer', () => {
    const cc = parseConventional(
      'feat(api): rewrite\n\nLong body about the rewrite.\n\nBREAKING CHANGE: drops v1 endpoints',
    );
    expect(cc.breaking).toBe(true);
    expect(cc.footers.BREAKING_CHANGE).toBe('drops v1 endpoints');
    expect(cc.body).toContain('Long body');
  });

  it('captures footer trailers like Refs:', () => {
    const cc = parseConventional('chore: bump dep\n\nRefs: #1234\nReviewed-by: Alice');
    expect(cc.footers.REFS).toBe('#1234');
    expect(cc.footers.REVIEWED_BY).toBe('Alice');
  });

  it('falls back gracefully on truly non-conventional headers', () => {
    const cc = parseConventional('just a freeform commit message');
    expect(cc.type).toBeNull();
    expect(cc.subject).toBe('just a freeform commit message');
  });

  it('detects clickup-skip in body', () => {
    const cc = parseConventional("feat: cleanup\n\nclickup-skip: this commit isn't user-facing");
    expect(cc.hasSkipMarker).toBe(true);
  });

  it('normaliseScope is robust against punctuation/case', () => {
    expect(normaliseScope('API-Gateway')).toBe('apigateway');
    expect(normaliseScope(null)).toBe('');
    expect(normaliseScope('v2/components')).toBe('v2components');
  });
});

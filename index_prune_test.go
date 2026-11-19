package main

import (
	"context"
	"path/filepath"
	"testing"
)

// testIndex opens a fresh index in a temp dir.
func testIndex(t *testing.T) *Index {
	t.Helper()
	ix, err := openIndex(filepath.Join(t.TempDir(), "index.sqlite"))
	if err != nil {
		t.Fatalf("open index: %v", err)
	}
	t.Cleanup(func() { ix.Close() })
	return ix
}

// TestForgetSessionUsesRanges pins the prune fast path: after a session is
// ingested its messages_fts rows sit in a recorded range, so forget must delete
// by rowid and must not leave the range behind. Before this, ForgetSession ran
// `DELETE FROM messages_fts WHERE session_pk = ?` — an unindexed column, i.e. a
// full scan of the FTS table per vanished session.
func TestForgetSessionUsesRanges(t *testing.T) {
	ix := testIndex(t)
	ctx := context.Background()

	keep := Session{Source: "grok", SourceID: "keep-1", Project: "/p", Title: "keep", MsgCount: 2}
	gone := Session{Source: "grok", SourceID: "gone-1", Project: "/p", Title: "gone", MsgCount: 2}
	if err := ix.IngestBatch(ctx, "grok", []Session{keep, gone}, []Message{
		{SourceID: "keep-1", Idx: 0, Role: "user", Text: "keep me"},
		{SourceID: "keep-1", Idx: 1, Role: "assistant", Text: "kept"},
		{SourceID: "gone-1", Idx: 0, Role: "user", Text: "delete me"},
		{SourceID: "gone-1", Idx: 1, Role: "assistant", Text: "deleted"},
	}); err != nil {
		t.Fatal(err)
	}

	var ranges int
	if err := ix.db.QueryRow(`SELECT COUNT(*) FROM msg_ranges WHERE session_pk = ?`, "grok:gone-1").Scan(&ranges); err != nil {
		t.Fatal(err)
	}
	if ranges == 0 {
		t.Fatalf("ingest recorded no msg_ranges row, so the fast path cannot be exercised")
	}

	if err := ix.ForgetSession("grok:gone-1"); err != nil {
		t.Fatal(err)
	}

	var sessions, rangesLeft int
	if err := ix.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id = ?`, "grok:gone-1").Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := ix.db.QueryRow(`SELECT COUNT(*) FROM msg_ranges WHERE session_pk = ?`, "grok:gone-1").Scan(&rangesLeft); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Errorf("session row survived forget: %d", sessions)
	}
	if rangesLeft != 0 {
		t.Errorf("msg_ranges row survived forget: %d", rangesLeft)
	}

	// The forgotten session's text must be unsearchable, and the neighbour intact.
	for _, tc := range []struct {
		query string
		want  int
	}{
		{"deleted", 0},
		{"kept", 1},
	} {
		hits, err := ix.Search(tc.query, SearchOpts{Limit: 10})
		if err != nil {
			t.Fatalf("%s: %v", tc.query, err)
		}
		if len(hits) != tc.want {
			t.Errorf("search %q = %d hits, want %d (%+v)", tc.query, len(hits), tc.want, hits)
		}
	}
}

// TestPruneMissingDropsOnlyUnseen guards the caller contract: prune is per
// source, and a source whose scan proved nothing must not lose rows.
func TestPruneMissingDropsOnlyUnseen(t *testing.T) {
	ix := testIndex(t)
	ctx := context.Background()
	if err := ix.IngestBatch(ctx, "grok", []Session{
		{Source: "grok", SourceID: "a", Title: "a", MsgCount: 1},
		{Source: "grok", SourceID: "b", Title: "b", MsgCount: 1},
	}, []Message{
		{SourceID: "a", Idx: 0, Role: "user", Text: "aaa"},
		{SourceID: "b", Idx: 0, Role: "user", Text: "bbb"},
	}); err != nil {
		t.Fatal(err)
	}
	// A second source in the same index, to prove prune stays per-source.
	if err := ix.IngestBatch(ctx, "kimi", []Session{
		{Source: "kimi", SourceID: "c", Title: "c", MsgCount: 1},
	}, []Message{
		{SourceID: "c", Idx: 0, Role: "user", Text: "ccc"},
	}); err != nil {
		t.Fatal(err)
	}

	// Empty seen set proves nothing and must be a no-op.
	if n, err := ix.PruneMissing("grok", nil); err != nil || n != 0 {
		t.Fatalf("empty seen: n=%d err=%v", n, err)
	}

	n, err := ix.PruneMissing("grok", map[string]bool{"a": true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("pruned %d, want 1", n)
	}
	// Other sources are untouched.
	hits, err := ix.Search("ccc", SearchOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Errorf("prune crossed sources: %d hits", len(hits))
	}
}

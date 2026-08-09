package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTestFile(t *testing.T, name, value string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRestoreSQLRejectsSchemaCreation(t *testing.T) {
	if err := validateRestoreSQLFile(writeTestFile(t, "ok.sql", "CREATE TABLE dune.t(id bigint); INSERT INTO dune.t VALUES (1);")); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{"CREATE SCHEMA dune;", "create schema authorization dune;", "CREATE SCHEMA IF NOT EXISTS \"dune\";"} {
		if err := validateRestoreSQLFile(writeTestFile(t, "bad.sql", sql)); err == nil {
			t.Fatalf("accepted %q", sql)
		}
	}
	if err := validateRestoreSQLFile(writeTestFile(t, "literal.sql", "SELECT 'CREATE SCHEMA dune;'; -- CREATE SCHEMA dune;\n")); err != nil {
		t.Fatal(err)
	}
}

func TestDuneTocBoundary(t *testing.T) {
	toc := `1; 0 0 ENCODING - ENCODING
2; 0 0 SCHEMA - dune dune
3; 0 0 TYPE dune thing dune
4; 0 0 TABLE dune t dune
5; 0 0 TABLE DATA dune t dune
6; 0 0 SEQUENCE dune t_id_seq dune
7; 0 0 SEQUENCE SET dune t_id_seq dune
8; 0 0 FUNCTION dune f() dune
9; 0 0 CONSTRAINT dune t t_pkey dune
10; 0 0 INDEX dune t_idx dune
11; 0 0 FK CONSTRAINT dune t t_fk dune
12; 0 0 TABLE ATTACH dune t_p dune
`
	if err := validateTocFile(writeTestFile(t, "toc", toc), "dune-only"); err != nil {
		t.Fatal(err)
	}
	if err := validateTocFile(writeTestFile(t, "outside", toc+"13; 0 0 TABLE public x postgres\n"), "dune-only"); err == nil {
		t.Fatal("outside object accepted")
	}
}

func TestFullBackupTocRequiresExtensions(t *testing.T) {
	toc := `1; 0 0 SCHEMA - dune dune
2; 0 0 EXTENSION - pgcrypto
3; 0 0 EXTENSION - pg_trgm
4; 0 0 TABLE dune t dune
`
	if err := validateTocFile(writeTestFile(t, "full", toc), "full-database"); err != nil {
		t.Fatal(err)
	}
}

func TestStructuredOfflineSamples(t *testing.T) {
	dir := t.TempDir()
	bg := `{"metadata":{"namespace":"test-ns","name":"test-bg"},"status":{"phase":"Stopped","serverGroupPhase":"Stopped","utilities":{"serverGateway":{"phase":"Suspended"},"director":{"phase":"Suspended"}}}}`
	workloads := `{"items":[{"kind":"Deployment","spec":{"replicas":0,"template":{"spec":{"containers":[{"image":"repo/seabass-server:2051294-0-shipping"}]}}}}]}`
	files := []string{"bg1.json", "bg2.json", "w1.json", "w2.json"}
	for index, value := range []string{bg, bg, workloads, workloads} {
		if err := os.WriteFile(filepath.Join(dir, files[index]), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateOfflineFiles(dir, OfflineValidation{BattlegroupFiles: files[:2], WorkloadFiles: files[2:], Namespace: "test-ns", Name: "test-bg"}); err != nil {
		t.Fatal(err)
	}
}

func TestTarOctalAcceptsStandardChecksumTerminator(t *testing.T) {
	value, err := parseTarOctal([]byte{'0', '0', '1', '2', '3', '4', 0, ' '})
	if err != nil || value != 668 {
		t.Fatalf("value=%d err=%v", value, err)
	}
}

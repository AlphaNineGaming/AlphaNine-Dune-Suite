-- Disposable fixture cluster ONLY. Never execute against a Suite database.
CREATE ROLE reader LOGIN PASSWORD 'fixture-reader-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE writer LOGIN PASSWORD 'fixture-writer-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE dune;
CREATE DATABASE unknown;
\connect dune
REVOKE CREATE ON DATABASE dune FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA dune;
CREATE TABLE dune.player_state (id bigint PRIMARY KEY, character_name text NOT NULL, online_status integer NOT NULL);
INSERT INTO dune.player_state VALUES (1, 'Synthetic player', 1);
GRANT USAGE ON SCHEMA dune TO reader, writer;
GRANT SELECT ON dune.player_state TO reader;
GRANT SELECT, UPDATE ON dune.player_state TO writer;
\connect unknown
REVOKE CREATE ON DATABASE unknown FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

// Database-backed suites always run against the *test* database.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://postgres:postgres@localhost:5432/ledgerlab_test";

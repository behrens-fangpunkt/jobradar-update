CREATE TABLE mail_accounts (
  owner TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  address TEXT NOT NULL,
  tokens TEXT NOT NULL
);

CREATE TABLE mail_connections (
  state TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  confirmation TEXT,
  address TEXT,
  tokens TEXT
);

CREATE INDEX mail_connections_owner ON mail_connections(owner);

CREATE TABLE mail_threads (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  business_id TEXT NOT NULL,
  company TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  thread_ref TEXT,
  latest_at INTEGER NOT NULL,
  latest_inbound INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX mail_threads_inbox ON mail_threads(owner, mailbox, latest_at DESC);

CREATE TABLE mail_sends (
  owner TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES mail_threads(id),
  provider_message TEXT,
  state TEXT NOT NULL CHECK(state IN ('sending', 'sent', 'failed')),
  created INTEGER NOT NULL,
  PRIMARY KEY(owner, mailbox, id)
);

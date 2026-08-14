-- Anonymous relay metadata only: no account, hostname, address, QR, plaintext
-- token, host secret, or application payload is persisted.
CREATE TABLE IF NOT EXISTS routes (
  route_id VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  generation INT UNSIGNED NOT NULL DEFAULT 0,
  disabled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  PRIMARY KEY (route_id),
  KEY routes_cleanup (disabled_at, last_seen_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS devices (
  route_id VARCHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- T1's domain-separated SHA-256 digest; NULL is allowed only for an explicitly
  -- revoked credential that never supplied a digest.
  credential_digest BINARY(32) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (route_id, device_id),
  CONSTRAINT devices_route_fk FOREIGN KEY (route_id)
    REFERENCES routes(route_id) ON DELETE CASCADE,
  KEY devices_route_active (route_id, revoked_at)
) ENGINE=InnoDB;

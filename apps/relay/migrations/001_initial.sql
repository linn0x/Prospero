-- Relay records are intentionally anonymous: no account, hostname, address, QR payload,
-- token plaintext, or application data is stored here.
CREATE TABLE IF NOT EXISTS routes (
  route_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  disabled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  PRIMARY KEY (route_id),
  KEY routes_cleanup (disabled_at, last_seen_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS devices (
  route_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role ENUM('host', 'client') NOT NULL,
  token_digest BINARY(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (route_id, device_id),
  CONSTRAINT devices_route_fk FOREIGN KEY (route_id)
    REFERENCES routes(route_id) ON DELETE CASCADE,
  KEY devices_route_active (route_id, revoked_at),
  KEY devices_token_digest (token_digest)
) ENGINE=InnoDB;

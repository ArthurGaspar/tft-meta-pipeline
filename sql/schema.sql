-- Normalized match data (written by the load function) and the aggregates and
-- tier lists computed from it (written by the aggregate function).
-- Compatible with MySQL 8 and MariaDB 10.6+.

CREATE TABLE IF NOT EXISTS matches (
  match_id      VARCHAR(32)  NOT NULL PRIMARY KEY,
  patch         VARCHAR(8)   NOT NULL,
  game_datetime DATETIME     NOT NULL,
  game_length_s DECIMAL(7,2) NOT NULL,
  source_key    VARCHAR(255) NOT NULL,
  INDEX ix_matches_patch (patch)
);

CREATE TABLE IF NOT EXISTS participants (
  match_id   VARCHAR(32) NOT NULL,
  puuid      VARCHAR(64) NOT NULL,
  placement  TINYINT     NOT NULL,
  level      TINYINT     NOT NULL,
  gold_left  SMALLINT    NOT NULL,
  last_round TINYINT     NOT NULL,
  damage     SMALLINT    NOT NULL,
  comp_key   VARCHAR(160) NOT NULL,
  carry_id   VARCHAR(64)  NOT NULL,
  playstyle  VARCHAR(8)   NOT NULL,          -- 'reroll', 'fast8' or 'fast9', read from the board
  carry_contest TINYINT   NOT NULL,          -- other boards in the lobby holding the carry
  PRIMARY KEY (match_id, puuid),
  INDEX ix_participants_comp (comp_key),
  CONSTRAINT fk_participants_match FOREIGN KEY (match_id) REFERENCES matches (match_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS participant_units (
  match_id     VARCHAR(32) NOT NULL,
  puuid        VARCHAR(64) NOT NULL,
  slot         TINYINT     NOT NULL,
  champion_id  VARCHAR(64) NOT NULL,
  star         TINYINT     NOT NULL,
  cost         TINYINT     NOT NULL,
  contested    TINYINT     NOT NULL,         -- other boards in the lobby holding this champion
  PRIMARY KEY (match_id, puuid, slot),
  INDEX ix_units_champion (champion_id),
  CONSTRAINT fk_units_participant FOREIGN KEY (match_id, puuid) REFERENCES participants (match_id, puuid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS unit_items (
  match_id    VARCHAR(32) NOT NULL,
  puuid       VARCHAR(64) NOT NULL,
  slot        TINYINT     NOT NULL,
  item_slot   TINYINT     NOT NULL,
  item_id     VARCHAR(64) NOT NULL,
  PRIMARY KEY (match_id, puuid, slot, item_slot),
  INDEX ix_items_item (item_id),
  CONSTRAINT fk_items_unit FOREIGN KEY (match_id, puuid, slot) REFERENCES participant_units (match_id, puuid, slot) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS participant_traits (
  match_id  VARCHAR(32) NOT NULL,
  puuid     VARCHAR(64) NOT NULL,
  trait_id  VARCHAR(64) NOT NULL,
  num_units TINYINT     NOT NULL,
  tier      TINYINT     NOT NULL,
  PRIMARY KEY (match_id, puuid, trait_id),
  CONSTRAINT fk_traits_participant FOREIGN KEY (match_id, puuid) REFERENCES participants (match_id, puuid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS participant_augments (
  match_id   VARCHAR(32) NOT NULL,
  puuid      VARCHAR(64) NOT NULL,
  pick_order TINYINT     NOT NULL,
  augment_id VARCHAR(96) NOT NULL,
  PRIMARY KEY (match_id, puuid, pick_order),
  INDEX ix_augments_augment (augment_id),
  CONSTRAINT fk_augments_participant FOREIGN KEY (match_id, puuid) REFERENCES participants (match_id, puuid) ON DELETE CASCADE
);

-- One row per staged file loaded, so a re-delivered event is skipped.
CREATE TABLE IF NOT EXISTS load_log (
  source_key VARCHAR(255) NOT NULL,
  etag       CHAR(32)     NOT NULL,
  matches    INT          NOT NULL,
  loaded_at  DATETIME     NOT NULL,
  PRIMARY KEY (source_key, etag)
);

-- Aggregates: one row per entity, patch and kind ('champion', 'item', 'augment', 'comp', 'trait').
CREATE TABLE IF NOT EXISTS entity_stats (
  kind          VARCHAR(16)  NOT NULL,
  entity_id     VARCHAR(160) NOT NULL,
  patch         VARCHAR(8)   NOT NULL,
  games         INT          NOT NULL,
  play_rate     DECIMAL(6,4) NOT NULL,
  avg_placement DECIMAL(5,3) NOT NULL,
  top4_rate     DECIMAL(6,4) NOT NULL,
  win_rate      DECIMAL(6,4) NOT NULL,
  score         DECIMAL(5,3) NOT NULL,
  tier          CHAR(1)      NULL,
  PRIMARY KEY (kind, entity_id, patch)
);

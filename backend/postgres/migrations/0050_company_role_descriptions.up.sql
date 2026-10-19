ALTER TABLE rotamoto.roles ADD COLUMN description text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 240);

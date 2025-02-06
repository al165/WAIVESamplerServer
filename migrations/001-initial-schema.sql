-- Up

CREATE TABLE Sources(
    id INTEGER PRIMARY KEY,
    archive STRING,
    description STRING,
    tags STRING,
    filename STRING,
    license STRING,
    hidden INTEGER
);

CREATE TABLE Archives (
    id INTEGER PRIMARY KEY,
    name STRING UNIQUE
);

-- Down

DROP TABLE Sources;
DROP TABLE Archives;

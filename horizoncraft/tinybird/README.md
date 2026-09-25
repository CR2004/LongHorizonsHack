# Tinybird

Datasource `events` + 3 endpoints: `recent_events`, `counters`, `context_tokens`.

    pip install tinybird-cli   # or: curl https://tinybird.co | sh  (Tinybird Forward CLI `tb`)
    tb login                   # pick your region
    tb --cloud deploy          # from this folder

Endpoints: `$TINYBIRD_HOST/v0/pipes/<name>.json?token=<READ token>`

#!/usr/bin/env bash
set -euo pipefail

TIMESTAMP=$(node -e 'console.log(Date.now())')
SIGNATURE=$(printf '%s' "$TIMESTAMP" | openssl dgst -sha256 -hmac "$INTERNAL_CALLBACK_SECRET" -hex | awk '{print $NF}')

curl -X PUT 'https://open-inspect-linear-bot-fountain.fountain.workers.dev/config/team-repos' \
  -H "Authorization: Bearer ${TIMESTAMP}.${SIGNATURE}" \
  -H "Content-Type: application/json" \
  -d '{
  "95e25668-877e-40c7-926b-76f0192af4d5": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "a65f6ac1-4e44-4934-9f15-5b1a77ee5eb1": [
    { "owner": "onboardiq", "name": "wx-system" },
    { "owner": "onboardiq", "name": "fountain-ai" }
  ],
  "df39f65c-9334-49aa-846a-00f6dd320fd5": [
    { "owner": "onboardiq", "name": "enterprise-wave" }
  ],
  "333d78ef-d08b-4199-8761-ac8594c5e80a": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "0b3bb912-cf55-4f39-a63b-50585a06fbc0": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "2a1a3340-7d77-4712-a99e-bfd1ccdbc573": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "fb93cf98-7178-4c8b-bac8-e36301fe2687": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "448a2eb1-3e1f-4b83-bade-d57b4c281823": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "2061accb-8337-438e-9dac-24e742840089": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "8cd17929-a187-453d-bb97-298b89292cc5": [
    { "owner": "onboardiq", "name": "wx-system", "label": "wx-system" },
    { "owner": "onboardiq", "name": "fountain-ai", "label": "fountain-ai" },
    { "owner": "onboardiq", "name": "enterprise-wave", "label": "enterprise-wave" },
    { "owner": "onboardiq", "name": "dent", "label": "dent" },
    { "owner": "onboardiq", "name": "monolith", "label": "monolith" },
    { "owner": "onboardiq", "name": "sourcery", "label": "sourcery" },
    { "owner": "onboardiq", "name": "wheregologin", "label": "wheregologin" }
  ],
  "9cf110e3-8085-4191-b6c6-da67fb914d65": [
    { "owner": "onboardiq", "name": "data-mcp", "label": "data-mcp" },
    { "owner": "onboardiq", "name": "data-cube", "label": "data-build" },
    { "owner": "onboardiq", "name": "data-build" }
  ],
  "4e6df924-c330-40a1-92a6-d6432950f907": [
    { "owner": "onboardiq", "name": "wx-system" }
  ],
  "e0c54d66-e26c-4e92-a695-5179989c6630": [
    { "owner": "onboardiq", "name": "wx-system" }
  ]
}'

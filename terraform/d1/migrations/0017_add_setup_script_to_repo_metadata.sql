-- Add setup_script column for storing per-repo image builder setup scripts.
-- Configured via the web interface, used by the EC2 image builder to
-- create custom AMIs (spin up base AMI → run script → create new AMI).
ALTER TABLE repo_metadata ADD COLUMN setup_script TEXT;

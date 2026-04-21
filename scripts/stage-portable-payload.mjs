#!/usr/bin/env node
import { delegateToSteamPackerCli } from './lib/delegate-to-steam-packer.mjs';

await delegateToSteamPackerCli('stage-portable-payload.mjs');

#!/usr/bin/env node
import { delegateToSteamPackerCli } from './lib/delegate-to-steam-packer.mjs';

await delegateToSteamPackerCli('package-desktop-portable.mjs');

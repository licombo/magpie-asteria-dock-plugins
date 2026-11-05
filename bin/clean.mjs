#!/usr/bin/env node
import { cleanMessage, cleanUsingDock } from "../lib/login.mjs"

const result = await cleanUsingDock()
console.log(cleanMessage(result))

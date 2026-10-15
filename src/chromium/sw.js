// Background service worker entry for the Chromium version.
// The compatibility layer must be evaluated before any other module.
import '../chromium/compat.js'
import '../_locales/dict.common.js'
import './background.js'

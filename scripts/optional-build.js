#!/usr/bin/env node
/**
 * Optional WASAPI bindings builder
 * 
 * Only builds native WASAPI bindings on Windows platform
 * Skips gracefully on Linux/macOS (uses PulseAudio/ALSA instead)
 * 
 * This prevents build failures on non-Windows platforms while
 * maintaining cross-platform compatibility
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const platform = process.platform;
const isWindows = platform === 'win32';

console.log(`[openclaw-voice] Platform detected: ${platform}`);

if (isWindows) {
  console.log('[openclaw-voice] Building WASAPI native bindings for Windows...');
  
  // Check if binding.gyp exists
  const bindingGypPath = path.join(__dirname, '..', 'binding.gyp');
  if (!fs.existsSync(bindingGypPath)) {
    console.error('[openclaw-voice] ERROR: binding.gyp not found');
    process.exit(1);
  }
  
  try {
    // Build WASAPI bindings using node-gyp
    execSync('node-gyp rebuild', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    
    console.log('[openclaw-voice] ✓ WASAPI bindings built successfully');
  } catch (error) {
    console.error('[openclaw-voice] ERROR: Failed to build WASAPI bindings');
    console.error('[openclaw-voice] Windows build requirements:');
    console.error('[openclaw-voice]   - Visual Studio 2019+ with C++ tools');
    console.error('[openclaw-voice]   - Windows SDK 10.0+');
    console.error('[openclaw-voice]   - Python 3.x (for node-gyp)');
    console.error('[openclaw-voice]');
    console.error('[openclaw-voice] Error details:', error.message);
    
    // Don't fail the install - allow fallback to Linux implementation
    console.warn('[openclaw-voice] WARNING: Continuing without WASAPI bindings');
    console.warn('[openclaw-voice] The service will use Linux audio (if available)');
    process.exit(0); // Exit success to allow npm install to continue
  }
} else {
  console.log('[openclaw-voice] Skipping WASAPI bindings (Windows-only feature)');
  console.log('[openclaw-voice] Using platform-native audio:');
  
  if (platform === 'linux') {
    console.log('[openclaw-voice]   - Linux: PulseAudio/ALSA');
  } else if (platform === 'darwin') {
    console.log('[openclaw-voice]   - macOS: CoreAudio (via Linux fallback for now)');
  } else {
    console.log('[openclaw-voice]   - Unknown platform, may require manual configuration');
  }
}

console.log('[openclaw-voice] Installation complete');

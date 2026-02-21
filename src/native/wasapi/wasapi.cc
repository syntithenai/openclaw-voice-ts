/**
 * WASAPI Native Bindings - Main Entry Point
 * 
 * Provides low-latency Windows Audio Session API (WASAPI) access from Node.js
 * Exports WASAPICapture and WASAPIPlayback classes
 * 
 * Platform: Windows only (compiled conditionally via binding.gyp)
 * 
 * Build Requirements:
 * - Visual Studio 2019+ (MSVC compiler)
 * - Windows SDK 10.0+
 * - Node.js 16+
 * - Python 3.x (for node-gyp)
 * 
 * Build Command:
 *   npm install (triggers node-gyp rebuild)
 */

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <wrl/client.h>

// Forward declarations
Napi::Object InitWASAPICapture(Napi::Env env, Napi::Object exports);
Napi::Object InitWASAPIPlayback(Napi::Env env, Napi::Object exports);

/**
 * Module initialization - called when require('wasapi-bindings') is executed
 */
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Initialize COM for WASAPI
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    Napi::Error::New(env, "Failed to initialize COM").ThrowAsJavaScriptException();
    return exports;
  }

  // Register WASAPICapture class
  InitWASAPICapture(env, exports);
  
  // Register WASAPIPlayback class
  InitWASAPIPlayback(env, exports);
  
  return exports;
}

NODE_API_MODULE(wasapi, Init)

#else
// Non-Windows platforms: Export empty module with error message

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  Napi::Error::New(env, 
    "WASAPI bindings are only available on Windows. "
    "This module should not be loaded on non-Windows platforms.").ThrowAsJavaScriptException();
  return exports;
}

NODE_API_MODULE(wasapi, Init)

#endif // _WIN32

/**
 * WASAPI Playback Implementation
 * 
 * Low-latency audio playback using Windows Audio Session API
 * Implements direct audio rendering with IAudioRenderClient
 * 
 * Latency Profile:
 * - Shared Mode: 15-30ms (compatible with multiple apps)
 * - Exclusive Mode: 5-10ms (single app, professional audio)
 */

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <napi.h>

#ifdef _WIN32

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <vector>
#include <string>
#include <algorithm>

using Microsoft::WRL::ComPtr;

/**
 * WASAPIPlayback class - Node.js wrapper for IAudioRenderClient
 */
class WASAPIPlayback : public Napi::ObjectWrap<WASAPIPlayback> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit WASAPIPlayback(const Napi::CallbackInfo& info);
  ~WASAPIPlayback();

private:
  // NAPI methods (callable from JavaScript)
  Napi::Value Play(const Napi::CallbackInfo& info);
  void Stop(const Napi::CallbackInfo& info);
  Napi::Value ListDevices(const Napi::CallbackInfo& info);

  // WASAPI internals
  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> audioClient_;
  ComPtr<IAudioRenderClient> renderClient_;
  WAVEFORMATEX* waveFormat_;
  bool isPlaying_;
  
  // Configuration
  int sampleRate_;
  int channels_;
  int bufferSize_;
  bool exclusiveMode_;
  
  // Internal helpers
  HRESULT InitializeWASAPI();
  HRESULT GetDefaultDevice();
  HRESULT WriteBuffer(const uint8_t* data, size_t length);
};

/**
 * Initialize WASAPIPlayback class for export
 */
Napi::Object WASAPIPlayback::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "WASAPIPlayback", {
    InstanceMethod("play", &WASAPIPlayback::Play),
    InstanceMethod("stop", &WASAPIPlayback::Stop),
    InstanceMethod("listDevices", &WASAPIPlayback::ListDevices)
  });
  
  Napi::FunctionReference* constructor = new Napi::FunctionReference();
  *constructor = Napi::Persistent(func);
  env.SetInstanceData(constructor);
  
  exports.Set("WASAPIPlayback", func);
  return exports;
}

/**
 * Constructor - called from JavaScript: new WASAPIPlayback(config)
 */
WASAPIPlayback::WASAPIPlayback(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WASAPIPlayback>(info),
      waveFormat_(nullptr),
      isPlaying_(false),
      sampleRate_(16000),
      channels_(1),
      bufferSize_(1024),
      exclusiveMode_(false) {
  
  Napi::Env env = info.Env();
  
  // Parse configuration object
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object config = info[0].As<Napi::Object>();
    
    if (config.Has("sampleRate")) {
      sampleRate_ = config.Get("sampleRate").As<Napi::Number>().Int32Value();
    }
    if (config.Has("channels")) {
      channels_ = config.Get("channels").As<Napi::Number>().Int32Value();
    }
    if (config.Has("bufferSize")) {
      bufferSize_ = config.Get("bufferSize").As<Napi::Number>().Int32Value();
    }
    if (config.Has("exclusiveMode")) {
      exclusiveMode_ = config.Get("exclusiveMode").As<Napi::Boolean>().Value();
    }
  }
  
  // Initialize WASAPI on construction
  HRESULT hr = InitializeWASAPI();
  if (FAILED(hr)) {
    Napi::Error::New(env, "Failed to initialize WASAPI playback").ThrowAsJavaScriptException();
  }
}

/**
 * Destructor - cleanup WASAPI resources
 */
WASAPIPlayback::~WASAPIPlayback() {
  if (isPlaying_ && audioClient_) {
    audioClient_->Stop();
  }
  
  if (waveFormat_) {
    CoTaskMemFree(waveFormat_);
  }
}

/**
 * Play audio buffer - returns Promise that resolves when playback completes
 */
Napi::Value WASAPIPlayback::Play(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected Buffer argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
  
  if (!renderClient_ || !audioClient_) {
    Napi::Error::New(env, "Playback not initialized").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  const uint8_t* data = buffer.Data();
  size_t dataSize = buffer.Length();
  
  // Start audio client if not already started
  if (!isPlaying_) {
    HRESULT hr = audioClient_->Start();
    if (FAILED(hr)) {
      Napi::Error::New(env, " to start audio client").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    isPlaying_ = true;
  }
  
  // Write buffer in chunks
  HRESULT hr = WriteBuffer(data, dataSize);
  if (FAILED(hr)) {
    Napi::Error::New(env, "Failed to write audio buffer").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  return env.Undefined();
}

/**
 * Stop current audio playback
 */
void WASAPIPlayback::Stop(const Napi::CallbackInfo& info) {
  if (isPlaying_ && audioClient_) {
    audioClient_->Stop();
    isPlaying_ = false;
  }
}

/**
 * List available WASAPI playback devices
 */
Napi::Value WASAPIPlayback::ListDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  Napi::Array devices = Napi::Array::New(env);
  
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                (void**)&enumerator);
  if (FAILED(hr)) {
    return devices;
  }
  
  ComPtr<IMMDeviceCollection> collection;
  hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection);
  if (FAILED(hr)) {
    return devices;
  }
  
  UINT count;
  hr = collection->GetCount(&count);
  if (FAILED(hr)) {
    return devices;
  }
  
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> device;
    hr = collection->Item(i, &device);
    if (FAILED(hr)) continue;
    
    // Get device name
    ComPtr<IPropertyStore> props;
    hr = device->OpenPropertyStore(STGM_READ, &props);
    if (FAILED(hr)) continue;
    
    PROPVARIANT varName;
    PropVariantInit(&varName);
    hr = props->GetValue(PKEY_Device_FriendlyName, &varName);
    if (SUCCEEDED(hr)) {
      Napi::Object deviceObj = Napi::Object::New(env);
      deviceObj.Set("index", i);
      
      // Convert WCHAR* to std::string
      int size = WideCharToMultiByte(CP_UTF8, 0, varName.pwszVal, -1, nullptr, 0, nullptr, nullptr);
      std::string name(size, 0);
      WideCharToMultiByte(CP_UTF8, 0, varName.pwszVal, -1, &name[0], size, nullptr, nullptr);
      name.resize(size - 1); // Remove null terminator
      
      deviceObj.Set("name", name);
      devices.Set(i, deviceObj);
      
      PropVariantClear(&varName);
    }
  }
  
  return devices;
}

/**
 * Initialize WASAPI - create device, audio client, render client
 */
HRESULT WASAPIPlayback::InitializeWASAPI() {
  HRESULT hr = GetDefaultDevice();
  if (FAILED(hr)) return hr;
  
  // Activate IAudioClient
  hr = device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                         (void**)&audioClient_);
  if (FAILED(hr)) return hr;
  
  // Get mix format
  hr = audioClient_->GetMixFormat(&waveFormat_);
  if (FAILED(hr)) return hr;
  
  // Override to requested format (16-bit mono PCM)
  waveFormat_->wFormatTag = WAVE_FORMAT_PCM;
  waveFormat_->nChannels = channels_;
  waveFormat_->nSamplesPerSec = sampleRate_;
  waveFormat_->wBitsPerSample = 16;
  waveFormat_->nBlockAlign = channels_ * 2;
  waveFormat_->nAvgBytesPerSec = sampleRate_ * waveFormat_->nBlockAlign;
  waveFormat_->cbSize = 0;
  
  // Calculate buffer duration
  REFERENCE_TIME bufferDuration = (REFERENCE_TIME)(10000000.0 * bufferSize_ / sampleRate_);
  
  // Initialize audio client
  hr = audioClient_->Initialize(
      exclusiveMode_ ? AUDCLNT_SHAREMODE_EXCLUSIVE : AUDCLNT_SHAREMODE_SHARED,
      0,
      bufferDuration,
      exclusiveMode_ ? bufferDuration : 0,
      waveFormat_,
      nullptr);
  if (FAILED(hr)) return hr;
  
  // Get render client service
  hr = audioClient_->GetService(__uuidof(IAudioRenderClient),
                                 (void**)&renderClient_);
  if (FAILED(hr)) return hr;
  
  return S_OK;
}

HRESULT WASAPIPlayback::GetDefaultDevice() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                (void**)&enumerator);
  if (FAILED(hr)) return hr;
  
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device_);
  return hr;
}

HRESULT WASAPIPlayback::WriteBuffer(const uint8_t* data, size_t length) {
  if (!renderClient_ || !audioClient_) return E_FAIL;
  
  UINT32 bufferFrameCount;
  HRESULT hr = audioClient_->GetBufferSize(&bufferFrameCount);
  if (FAILED(hr)) return hr;
  
  size_t framesToWrite = length / (channels_ * sizeof(int16_t));
  size_t offset = 0;
  
  while (framesToWrite > 0) {
    // Get current padding (frames already in buffer)
    UINT32 numFramesPadding;
    hr = audioClient_->GetCurrentPadding(&numFramesPadding);
    if (FAILED(hr)) return hr;
    
    // Calculate available frames
    UINT32 numFramesAvailable = bufferFrameCount - numFramesPadding;
    if (numFramesAvailable == 0) {
      // Buffer full, wait a bit
      Sleep(10);
      continue;
    }
    
    // Write available frames (but not more than we have)
    UINT32 numFramesToWrite = (UINT32)min(numFramesAvailable, framesToWrite);
    
    BYTE* pData;
    hr = renderClient_->GetBuffer(numFramesToWrite, &pData);
    if (FAILED(hr)) return hr;
    
    // Copy audio data
    size_t bytesToCopy = numFramesToWrite * channels_ * sizeof(int16_t);
    memcpy(pData, data + offset, bytesToCopy);
    
    hr = renderClient_->ReleaseBuffer(numFramesToWrite, 0);
    if (FAILED(hr)) return hr;
    
    offset += bytesToCopy;
    framesToWrite -= numFramesToWrite;
  }
  
  return S_OK;
}

/**
 * Export initialization function
 */
Napi::Object InitWASAPIPlayback(Napi::Env env, Napi::Object exports) {
  return WASAPIPlayback::Init(env, exports);
}

#else
// Non-Windows stub
Napi::Object InitWASAPIPlayback(Napi::Env env, Napi::Object exports) {
  return exports;
}
#endif // _WIN32

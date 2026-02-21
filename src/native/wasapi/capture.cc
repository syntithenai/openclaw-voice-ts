/**
 * WASAPI Capture Implementation
 * 
 * Low-latency audio capture using Windows Audio Session API
 * Implements event-driven frame capture with IAudioCaptureClient
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

using Microsoft::WRL::ComPtr;

/**
 * WASAPICapture class - Node.js wrapper for IAudioCaptureClient
 */
class WASAPICapture : public Napi::ObjectWrap<WASAPICapture> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports);
  explicit WASAPICapture(const Napi::CallbackInfo& info);
  ~WASAPICapture();

private:
  // NAPI methods (callable from JavaScript)
  Napi::Value Start(const Napi::CallbackInfo& info);
  Napi::Value GetFrame(const Napi::CallbackInfo& info);
  void Stop(const Napi::CallbackInfo& info);
  static Napi::Value EnumerateDevices(const Napi::CallbackInfo& info);

  // WASAPI internals
  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> audioClient_;
  ComPtr<IAudioCaptureClient> captureClient_;
  HANDLE eventHandle_;
  WAVEFORMATEX* waveFormat_;
  bool isCapturing_;
  
  // Configuration
  int sampleRate_;
  int channels_;
  int bufferSize_;
  bool exclusiveMode_;
  int deviceIndex_;
  
  // Internal helpers
  HRESULT InitializeWASAPI();
  HRESULT GetDefaultDevice();
  HRESULT GetDeviceByIndex(int index);
};

/**
 * Initialize WASAPICapture class for export
 */
Napi::Object WASAPICapture::Init(Napi::Env env, Napi::Object exports) {
  Napi::Function func = DefineClass(env, "WASAPICapture", {
    InstanceMethod("start", &WASAPICapture::Start),
    InstanceMethod("getFrame", &WASAPICapture::GetFrame),
    InstanceMethod("stop", &WASAPICapture::Stop),
    StaticMethod("enumerateDevices", &WASAPICapture::EnumerateDevices)
  });
  
  Napi::FunctionReference* constructor = new Napi::FunctionReference();
  *constructor = Napi::Persistent(func);
  env.SetInstanceData(constructor);
  
  exports.Set("WASAPICapture", func);
  return exports;
}

/**
 * Constructor - called from JavaScript: new WASAPICapture(config)
 */
WASAPICapture::WASAPICapture(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WASAPICapture>(info),
      eventHandle_(nullptr),
      waveFormat_(nullptr),
      isCapturing_(false),
      sampleRate_(16000),
      channels_(1),
      bufferSize_(1024),
      exclusiveMode_(false),
      deviceIndex_(0) {
  
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
    if (config.Has("deviceIndex")) {
      deviceIndex_ = config.Get("deviceIndex").As<Napi::Number>().Int32Value();
    }
  }
}

/**
 * Destructor - cleanup WASAPI resources
 */
WASAPICapture::~WASAPICapture() {
  if (isCapturing_) {
    audioClient_->Stop();
  }
  
  if (eventHandle_) {
    CloseHandle(eventHandle_);
  }
  
  if (waveFormat_) {
    CoTaskMemFree(waveFormat_);
  }
}

/**
 * Start WASAPI capture - initializes IAudioClient and IAudioCaptureClient
 */
Napi::Value WASAPICapture::Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  HRESULT hr = InitializeWASAPI();
  if (FAILED(hr)) {
    Napi::Error::New(env, "Failed to initialize WASAPI capture").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  hr = audioClient_->Start();
  if (FAILED(hr)) {
    Napi::Error::New(env, "Failed to start WASAPI audio client").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  isCapturing_ = true;
  return env.Undefined();
}

/**
 * Get next audio frame - returns Promise<Buffer>
 * Waits for WASAPI event notification (event-driven, low latency)
 */
Napi::Value WASAPICapture::GetFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  
  if (!isCapturing_ || !captureClient_) {
    Napi::Error::New(env, "Capture not started").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  
  // Wait for buffer ready event (100ms timeout)
  DWORD waitResult = WaitForSingleObject(eventHandle_, 100);
  if (waitResult != WAIT_OBJECT_0) {
    // Timeout or error - return empty buffer
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  
  UINT32 packetLength = 0;
  HRESULT hr = captureClient_->GetNextPacketSize(&packetLength);
  if (FAILED(hr) || packetLength == 0) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  
  BYTE* pData;
  UINT32 numFramesAvailable;
  DWORD flags;
  
  hr = captureClient_->GetBuffer(&pData, &numFramesAvailable, &flags, nullptr, nullptr);
  if (FAILED(hr)) {
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  
  // Calculate buffer size (16-bit mono)
  size_t dataSize = numFramesAvailable * channels_ * sizeof(int16_t);
  
  // Create Node.js Buffer and copy data
  Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::New(env, dataSize);
  
  if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
    // Silent buffer - fill with zeros
    memset(buffer.Data(), 0, dataSize);
  } else {
    // Copy audio data
    memcpy(buffer.Data(), pData, dataSize);
  }
  
  // Release buffer
  captureClient_->ReleaseBuffer(numFramesAvailable);
  
  return buffer;
}

/**
 * Stop WASAPI capture
 */
void WASAPICapture::Stop(const Napi::CallbackInfo& info) {
  if (isCapturing_ && audioClient_) {
    audioClient_->Stop();
    isCapturing_ = false;
  }
}

/**
 * Enumerate available WASAPI capture devices (static method)
 */
Napi::Value WASAPICapture::EnumerateDevices(const Napi::CallbackInfo& info) {
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
  hr = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection);
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
      int size = WideCharToMultiByte(CP_UTF8, 0, varName.pwszVal, -1, nullptr, 0, nullptr,nullptr);
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
 * Initialize WASAPI - create device, audio client, capture client
 */
HRESULT WASAPICapture::InitializeWASAPI() {
  HRESULT hr;
  
  // Get audio endpoint device
  if (deviceIndex_ == 0) {
    hr = GetDefaultDevice();
  } else {
    hr = GetDeviceByIndex(deviceIndex_);
  }
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
  
  // Calculate buffer duration (~64ms for 1024 frames at 16kHz)
  REFERENCE_TIME bufferDuration = (REFERENCE_TIME)(10000000.0 * bufferSize_ / sampleRate_);
  
  // Initialize audio client
  DWORD streamFlags = exclusiveMode_ ? AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                                      : AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  
  hr = audioClient_->Initialize(
      exclusiveMode_ ? AUDCLNT_SHAREMODE_EXCLUSIVE : AUDCLNT_SHAREMODE_SHARED,
      streamFlags,
      bufferDuration,
      exclusiveMode_ ? bufferDuration : 0,
      waveFormat_,
      nullptr);
  if (FAILED(hr)) return hr;
  
  // Create event for buffer ready notification
  eventHandle_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  if (!eventHandle_) return E_FAIL;
  
  hr = audioClient_->SetEventHandle(eventHandle_);
  if (FAILED(hr)) return hr;
  
  // Get capture client service
  hr = audioClient_->GetService(__uuidof(IAudioCaptureClient),
                                 (void**)&captureClient_);
  if (FAILED(hr)) return hr;
  
  return S_OK;
}

HRESULT WASAPICapture::GetDefaultDevice() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                (void**)&enumerator);
  if (FAILED(hr)) return hr;
  
  hr = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device_);
  return hr;
}

HRESULT WASAPICapture::GetDeviceByIndex(int index) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                (void**)&enumerator);
  if (FAILED(hr)) return hr;
  
  ComPtr<IMMDeviceCollection> collection;
  hr = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection);
  if (FAILED(hr)) return hr;
  
  hr = collection->Item(index, &device_);
  return hr;
}

/**
 * Export initialization function
 */
Napi::Object InitWASAPICapture(Napi::Env env, Napi::Object exports) {
  return WASAPICapture::Init(env, exports);
}

#else
// Non-Windows stub
Napi::Object InitWASAPICapture(Napi::Env env, Napi::Object exports) {
  return exports;
}
#endif // _WIN32

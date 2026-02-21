{
  "targets": [
    {
      "target_name": "wasapi",
      "sources": [
        "src/native/wasapi/wasapi.cc",
        "src/native/wasapi/capture.cc",
        "src/native/wasapi/playback.cc"
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "libraries": [
        "MMDevApi.lib",
        "AudioSes.lib",
        "Ole32.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/EHsc"],
          "ExceptionHandling": 1
        }
      },
      "conditions": [
        [
          "OS != 'win32'",
          {
            "sources!": [
              "src/native/wasapi/wasapi.cc",
              "src/native/wasapi/capture.cc",
              "src/native/wasapi/playback.cc"
            ]
          }
        ]
      ]
    }
  ]
}

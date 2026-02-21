import os
import tempfile
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

def _env_dump() -> dict:
    return {
        "WHISPER_MODEL": os.getenv("WHISPER_MODEL", "base"),
        "WHISPER_DEVICE": os.getenv("WHISPER_DEVICE", "auto"),
        "WHISPER_COMPUTE_TYPE": os.getenv("WHISPER_COMPUTE_TYPE", "int8"),
    }

app = FastAPI()

MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
DEVICE_SETTING = os.getenv("WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

_model = None


def _resolve_device() -> str:
    if DEVICE_SETTING == "cpu":
        return "cpu"
    if DEVICE_SETTING == "cuda":
        return "cuda"
    # faster-whisper auto-detection
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


@app.on_event("startup")
def load_model() -> None:
    global _model
    device = _resolve_device()
    try:
        _model = WhisperModel(
            MODEL_NAME,
            device=device,
            compute_type=COMPUTE_TYPE,
            download_root="/models"
        )
        print(f"Loaded faster-whisper model: {MODEL_NAME} on {device} with {COMPUTE_TYPE}", flush=True)
    except Exception as exc:
        print("Failed to load model", exc, _env_dump(), flush=True)
        raise


@app.get("/")
def health():
    device = _resolve_device()
    return {
        "status": "running",
        "model_status": "loaded" if _model is not None else "loading",
        "model_name": MODEL_NAME,
        "device": device,
        "compute_type": COMPUTE_TYPE,
        "backend": "faster-whisper",
        "env": _env_dump(),
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str | None = Form(None)):
    if _model is None:
        return JSONResponse(status_code=503, content={"detail": "model not loaded"})

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(await file.read())
        tmp.flush()
        
        # faster-whisper API
        segments, info = _model.transcribe(
            tmp.name,
            language=language,
            beam_size=5,
            vad_filter=False
        )
        
        # Collect all segment text
        text = " ".join([segment.text for segment in segments])

    return {"text": text.strip()}

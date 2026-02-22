"""
OpenWakeWord HTTP Service Wrapper

Provides REST API for low-latency wake word detection.
Uses openWakeWord library for fast audio-based detection instead of full STT.
"""

import os
import logging
import numpy as np
from typing import Dict, List
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import base64

# Try to import openwakeword, fall back gracefully if not available
try:
    from openwakeword.model import Model
    OPENWAKEWORD_AVAILABLE = True
except ImportError:
    OPENWAKEWORD_AVAILABLE = False
    logging.warning("openWakeWord not installed - detection will be unavailable")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(title="OpenWakeWord Service", version="1.0.0")

# Global model instance
oww_model = None

class AudioRequest(BaseModel):
    """Audio chunk for detection"""
    audio_base64: str
    wake_words: List[str] = ["hey google"]
    sample_rate: int = 16000

class DetectionResponse(BaseModel):
    """Wake word detection result"""
    detected: bool
    top_match: str | None = None
    top_confidence: float
    all_scores: Dict[str, float]

class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    available: bool
    models_loaded: bool

def init_model():
    """Initialize openWakeWord model"""
    global oww_model
    
    if not OPENWAKEWORD_AVAILABLE:
        logger.error("openWakeWord library not installed")
        return False
    
    try:
        logger.info("Initializing OpenWakeWord model...")
        oww_model = Model(
            inference_framework="onnx",
            model_path=os.getenv("OPENWAKEWORD_MODELS", "/models")
        )
        logger.info("✓ OpenWakeWord model loaded successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to initialize OpenWakeWord model: {e}")
        return False

@app.on_event("startup")
async def startup_event():
    """Initialize model on startup"""
    success = init_model()
    if success:
        logger.info("Service ready for detection")
    else:
        logger.warning("Service started but detection may be unavailable")

@app.get("/health")
async def health() -> HealthResponse:
    """Health check endpoint"""
    return HealthResponse(
        status="healthy" if oww_model else "degraded",
        available=OPENWAKEWORD_AVAILABLE,
        models_loaded=oww_model is not None
    )

@app.post("/detect")
async def detect_wake_word(request: AudioRequest) -> DetectionResponse:
    """
    Detect wake words in audio chunk
    
    Args:
        audio_base64: Base64-encoded 16-bit PCM audio
        wake_words: List of wake words to detect
        sample_rate: Audio sample rate (default 16000)
    
    Returns:
        DetectionResponse with confidence scores
    """
    if not oww_model:
        raise HTTPException(status_code=503, detail="Model not loaded")
    
    try:
        # Decode audio from base64
        audio_bytes = base64.b64decode(request.audio_base64)
        
        # Convert bytes to int16 array
        audio_samples = np.frombuffer(audio_bytes, dtype=np.int16)
        
        # Normalize to float32 [-1, 1]
        audio_float = audio_samples.astype(np.float32) / 32768.0
        
        # Run inference
        scores = oww_model.predict(
            audio_float,
            request.wake_words,
            sample_rate=request.sample_rate
        )
        
        # Find best match
        top_match = max(scores.items(), key=lambda x: x[1])
        top_word = top_match[0]
        top_confidence = float(top_match[1])
        
        # Convert all scores to float
        all_scores = {k: float(v) for k, v in scores.items()}
        
        # Detection threshold (configurable via env)
        threshold = float(os.getenv("DETECTION_THRESHOLD", "0.5"))
        detected = top_confidence >= threshold
        
        return DetectionResponse(
            detected=detected,
            top_match=top_word if detected else None,
            top_confidence=top_confidence,
            all_scores=all_scores
        )
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid audio format: {e}")
    except Exception as e:
        logger.error(f"Detection error: {e}")
        raise HTTPException(status_code=500, detail="Detection failed")

@app.get("/models")
async def list_models() -> Dict:
    """List available models"""
    if not oww_model:
        return {"models": [], "available": False}
    
    # Try to list available models
    try:
        models = oww_model.available_models()
        return {"models": models, "available": True}
    except:
        return {"models": [], "note": "Use default models"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8082"))
    uvicorn.run(app, host="0.0.0.0", port=port)

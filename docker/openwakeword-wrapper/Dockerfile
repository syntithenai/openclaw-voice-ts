FROM python:3.10-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir \
    openwakeword>=0.5.0 \
    fastapi \
    uvicorn[standard] \
    numpy \
    soundfile \
    requests

# Copy application
COPY app.py .

# Create models directory
RUN mkdir -p /models

# Set environment variables
ENV OPENWAKEWORD_MODELS=/models
ENV PORT=8082
ENV DETECTION_THRESHOLD=0.5
ENV PYTHONUNBUFFERED=1

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8082/health || exit 1

EXPOSE 8082

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8082"]

export class WhisperClient {
  constructor(private baseUrl: string) {
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/`, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async transcribe(wavBuffer: Buffer, language?: string): Promise<string> {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
    form.append('file', blob, 'audio.wav');
    if (language) {
      form.append('language', language);
    }

    const response = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Whisper transcription failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { text?: string };
    return (data.text || '').trim();
  }
}

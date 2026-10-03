# Live-Spracherkennung fuer das Diktat, siehe server.py.
# Das Modell (45 MB) steckt im Bild -- kein Datenordner, nichts zu laden beim Start.
FROM python:3.12-slim
RUN pip install --no-cache-dir vosk==0.3.45 websockets==15.0.1
RUN python -c "import urllib.request, zipfile, io; \
z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen('https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip').read())); \
z.extractall('/'); import os; os.rename('/vosk-model-small-de-0.15', '/modell')"
COPY server.py /server.py
EXPOSE 2700
CMD ["python", "-u", "/server.py"]

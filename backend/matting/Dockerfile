FROM public.ecr.aws/docker/library/python:3.12-slim
WORKDIR /app
ARG PYTHON_PACKAGE_INDEX=https://pypi.org/simple
RUN pip install --no-cache-dir --timeout 30 --retries 2 --index-url ${PYTHON_PACKAGE_INDEX} numpy==2.2.6 Pillow==11.3.0 onnxruntime==1.23.2
COPY server.py /app/server.py
USER 65534:65534
CMD ["python", "server.py"]

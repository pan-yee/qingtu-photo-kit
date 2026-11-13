ARG PYTHON_BASE_IMAGE=public.ecr.aws/docker/library/python:3.12-slim
FROM scratch AS wheel_cache
FROM ${PYTHON_BASE_IMAGE}
WORKDIR /app
ARG PYTHON_PACKAGE_INDEX=https://pypi.org/simple
COPY requirements.txt /app/requirements.txt
RUN --mount=type=secret,id=proxy_ca --mount=type=bind,from=wheel_cache,target=/wheel_cache \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    if ls /wheel_cache/*.whl >/dev/null 2>&1; then \
      pip install --no-cache-dir --no-index --find-links /wheel_cache -r requirements.txt; \
    else \
      pip install --no-cache-dir --timeout 30 --retries 2 --index-url ${PYTHON_PACKAGE_INDEX} -r requirements.txt; \
    fi
COPY --chmod=644 server.py framing.py matte_cleanup.py /app/
COPY --chmod=644 assets/face_detection_yunet_2023mar.onnx assets/LICENSE.YuNet /app/assets/
USER 65534:65534
CMD ["python", "server.py"]

ARG PYTHON_BASE_IMAGE=public.ecr.aws/docker/library/python:3.12-slim
FROM ${PYTHON_BASE_IMAGE}
WORKDIR /app
ARG PYTHON_PACKAGE_INDEX=https://pypi.org/simple
COPY requirements.txt /app/requirements.txt
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    pip install --no-cache-dir --timeout 30 --retries 2 --index-url ${PYTHON_PACKAGE_INDEX} -r requirements.txt
COPY --chmod=644 server.py framing.py /app/
USER 65534:65534
CMD ["python", "server.py"]

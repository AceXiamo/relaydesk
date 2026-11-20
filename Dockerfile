FROM python:3.13-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY server.py assistant_chat.py ./
COPY public/ public/
COPY integrations/telegram.py integrations/telegram.py
RUN mkdir -p /app/data && chown 10001:10001 /app/data
USER 10001:10001
EXPOSE 8787
CMD ["python", "server.py", "--host", "0.0.0.0"]

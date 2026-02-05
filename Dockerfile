# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/Dockerfile

# Use minimal Python alpine image
FROM python:3.12-alpine

# Install coturn
RUN apk add --no-cache coturn

# Set working directory
WORKDIR /app

# Copy requirements file
COPY requirements.txt .

# Set up Python environment and install dependencies
RUN python3 -m pip install --upgrade pip && python3 -m pip install --no-cache-dir --only-binary :all: -r requirements.txt --upgrade

# Cleanup the python requirements file (not needed at runtime)
RUN rm requirements.txt

# Copy only the necessary application files
COPY config.py .
COPY server.py .
COPY static/ static/

# Start script that configures coturn and runs services
CMD sh -c 'turnserver -c /etc/turnserver.conf & python3 server.py'
# Use the official Deno image as the base image
FROM denoland/deno:alpine

# Set the working directory in the container
WORKDIR /app

# Deno natively reads package.json now!
COPY package.json ./

# Install dependencies (creates a deno.lock if one doesn't exist)
RUN deno install

# Copy the current directory contents into the container at /app
COPY . .

# Expose the port on which the API will listen
EXPOSE 8080

# Run the server when the container launches (-A gives it permission to read files/network)
CMD ["deno", "run", "-A", "src/server/index.ts"]
# Use Apify's Playwright image with Chrome pre-installed
FROM apify/actor-node-playwright-chrome:20

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev --no-optional \
    && echo "Installed NPM packages:" \
    && npm list --omit=dev --no-optional --all || true \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Copy the rest of the source code
COPY . ./

# Run the actor
CMD ["node", "src/main.js"]

#!/bin/bash

# ═══════════════════════════════════════════════════════════════════════════════
# ORACLE PRO - AUTOMATED SETUP SCRIPT
# Run this to set up the entire project in one command
# ═══════════════════════════════════════════════════════════════════════════════

echo "
╔═══════════════════════════════════════════════════════════════════╗
║                    🚀 ORACLE PRO SETUP                            ║
║              Automated Installation Script                        ║
╚═══════════════════════════════════════════════════════════════════╝
"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed!${NC}"
    echo "Please install Node.js 18+ from https://nodejs.org"
    exit 1
fi

echo -e "${GREEN}✅ Node.js found: $(node --version)${NC}"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ npm found: $(npm --version)${NC}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  STEP 1: Creating project structure"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Create directories
mkdir -p oracle-pro/backend
mkdir -p oracle-pro/frontend
mkdir -p oracle-pro/docs

echo -e "${GREEN}✅ Project structure created${NC}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  STEP 2: Setting up backend"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd oracle-pro/backend

# Create package.json
cat > package.json << 'EOF'
{
  "name": "oracle-pro-backend",
  "version": "1.0.0",
  "description": "ORACLE Pro Trading System - Backend API",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "axios": "^1.6.0",
    "node-cron": "^3.0.3",
    "@supabase/supabase-js": "^2.39.0",
    "node-telegram-bot-api": "^0.64.0",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
EOF

echo -e "${YELLOW}📦 Installing backend dependencies...${NC}"
npm install

# Create .env.example
cat > .env.example << 'EOF'
NODE_ENV=development
PORT=3001

SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key

ALPHA_VANTAGE_KEY=your_alpha_vantage_key
RESEND_API_KEY=your_resend_key
TELEGRAM_BOT_TOKEN=your_telegram_token
ANTHROPIC_API_KEY=your_anthropic_key
EOF

# Create .gitignore
cat > .gitignore << 'EOF'
node_modules/
.env
.DS_Store
*.log
EOF

echo -e "${GREEN}✅ Backend setup complete${NC}"

cd ..

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  STEP 3: Setting up frontend (Next.js)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd frontend

# Check if user wants to use Next.js
echo -e "${YELLOW}Do you want to use Next.js for the frontend? (y/n)${NC}"
read -r use_nextjs

if [[ $use_nextjs == "y" || $use_nextjs == "Y" ]]; then
    echo -e "${YELLOW}Creating Next.js app...${NC}"
    npx create-next-app@latest . --typescript --tailwind --app --no-src-dir --import-alias "@/*"
else
    echo -e "${YELLOW}Setting up basic React...${NC}"
    npm create vite@latest . -- --template react
    npm install
fi

# Create .env.local
cat > .env.local << 'EOF'
NEXT_PUBLIC_API_URL=http://localhost:3001
EOF

echo -e "${GREEN}✅ Frontend setup complete${NC}"

cd ..

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  STEP 4: Creating documentation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Move docs to docs folder
mv README.md docs/ 2>/dev/null || true
mv DEPLOYMENT_GUIDE.md docs/ 2>/dev/null || true

echo -e "${GREEN}✅ Documentation organized${NC}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  STEP 5: Initializing Git repository"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

git init

# Create root .gitignore
cat > .gitignore << 'EOF'
node_modules/
.env
.env.local
.DS_Store
*.log
.vercel
.railway
dist/
build/
EOF

echo -e "${GREEN}✅ Git repository initialized${NC}"

echo ""
echo "
╔═══════════════════════════════════════════════════════════════════╗
║                    ✅ SETUP COMPLETE!                             ║
╚═══════════════════════════════════════════════════════════════════╝
"

echo -e "${GREEN}🎉 ORACLE Pro has been set up successfully!${NC}"
echo ""
echo "📝 Next steps:"
echo ""
echo "1. Configure your environment variables:"
echo "   ${YELLOW}cd oracle-pro/backend${NC}"
echo "   ${YELLOW}cp .env.example .env${NC}"
echo "   ${YELLOW}# Edit .env with your API keys${NC}"
echo ""
echo "2. Start the backend:"
echo "   ${YELLOW}npm run dev${NC}"
echo ""
echo "3. In another terminal, start the frontend:"
echo "   ${YELLOW}cd oracle-pro/frontend${NC}"
echo "   ${YELLOW}npm run dev${NC}"
echo ""
echo "4. Open your browser:"
echo "   ${YELLOW}http://localhost:3000${NC} (frontend)"
echo "   ${YELLOW}http://localhost:3001${NC} (backend)"
echo ""
echo "📖 Full documentation: ${YELLOW}docs/DEPLOYMENT_GUIDE.md${NC}"
echo ""
echo "🚀 Ready to deploy? Follow the guide for Railway + Vercel deployment!"
echo ""

#!/bin/bash

# Docker management scripts for Travel Guide Backend

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Detect docker-compose command (V1 vs V2)
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
elif command -v docker &> /dev/null && docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    echo -e "${RED}Error: Neither 'docker-compose' nor 'docker compose' is available.${NC}"
    echo -e "${YELLOW}Please install Docker Compose: https://docs.docker.com/compose/install/${NC}"
    exit 1
fi

# Build all services
build() {
    echo -e "${GREEN}Building Docker images...${NC}"
    $DOCKER_COMPOSE build --no-cache
}

# Start all services
start() {
    echo -e "${GREEN}Starting all services...${NC}"
    $DOCKER_COMPOSE up -d
    echo -e "${GREEN}Services started!${NC}"
    echo -e "${YELLOW}View logs: ./docker-scripts.sh logs${NC}"
}

# Stop all services
stop() {
    echo -e "${YELLOW}Stopping all services...${NC}"
    $DOCKER_COMPOSE down
    echo -e "${GREEN}Services stopped!${NC}"
}

# Restart all services
restart() {
    echo -e "${YELLOW}Restarting services...${NC}"
    $DOCKER_COMPOSE restart
}

# View logs
logs() {
    if [ -z "$1" ]; then
        $DOCKER_COMPOSE logs -f
    else
        $DOCKER_COMPOSE logs -f "$1"
    fi
}

# Check service status
status() {
    $DOCKER_COMPOSE ps
}

# Clean everything (including volumes)
clean() {
    echo -e "${RED}This will remove all containers, volumes, and images. Are you sure? (y/N)${NC}"
    read -r response
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo -e "${RED}Cleaning up...${NC}"
        $DOCKER_COMPOSE down -v
        docker system prune -af --volumes
        echo -e "${GREEN}Cleanup complete!${NC}"
    else
        echo -e "${YELLOW}Cleanup cancelled.${NC}"
    fi
}

# Execute command in backend container
exec_backend() {
    $DOCKER_COMPOSE exec backend "$@"
}

# Execute command in worker container
exec_worker() {
    $DOCKER_COMPOSE exec worker "$@"
}

# Show memory usage
memory() {
    echo -e "${GREEN}Container Memory Usage:${NC}"
    docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"
}

# Health check
health() {
    echo -e "${GREEN}Service Health Status:${NC}"
    services=("postgres" "redis" "libretranslate" "backend" "worker")
    for service in "${services[@]}"; do
        status=$($DOCKER_COMPOSE ps -q "$service" 2>/dev/null)
        if [ -n "$status" ]; then
            health=$(docker inspect --format='{{.State.Health.Status}}' "travel-$service" 2>/dev/null || echo "no healthcheck")
            echo -e "$service: ${GREEN}$health${NC}"
        else
            echo -e "$service: ${RED}not running${NC}"
        fi
    done
}

# Database backup
backup_db() {
    BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"
    echo -e "${GREEN}Creating database backup: $BACKUP_FILE${NC}"
    $DOCKER_COMPOSE exec -T postgres pg_dump -U travel travel_guides > "$BACKUP_FILE"
    echo -e "${GREEN}Backup complete: $BACKUP_FILE${NC}"
}

# Database restore
restore_db() {
    if [ -z "$1" ]; then
        echo -e "${RED}Usage: ./docker-scripts.sh restore_db <backup_file.sql>${NC}"
        exit 1
    fi
    echo -e "${YELLOW}Restoring database from: $1${NC}"
    cat "$1" | $DOCKER_COMPOSE exec -T postgres psql -U travel travel_guides
    echo -e "${GREEN}Database restored!${NC}"
}

# Show help
help() {
    echo -e "${GREEN}Travel Guide Backend - Docker Management Scripts${NC}"
    echo -e "${YELLOW}Using: $DOCKER_COMPOSE${NC}"
    echo ""
    echo "Usage: ./docker-scripts.sh [command]"
    echo ""
    echo "Commands:"
    echo "  build           - Build all Docker images"
    echo "  start           - Start all services"
    echo "  stop            - Stop all services"
    echo "  restart         - Restart all services"
    echo "  logs [service]  - View logs (optionally for specific service)"
    echo "  status          - Show service status"
    echo "  clean           - Remove all containers, volumes, and images"
    echo "  memory          - Show memory usage of containers"
    echo "  health          - Check health status of all services"
    echo "  backup_db       - Create database backup"
    echo "  restore_db <f>  - Restore database from backup file"
    echo "  exec_backend    - Execute command in backend container"
    echo "  exec_worker     - Execute command in worker container"
    echo "  help            - Show this help message"
    echo ""
    echo "Examples:"
    echo "  ./docker-scripts.sh start"
    echo "  ./docker-scripts.sh logs backend"
    echo "  ./docker-scripts.sh exec_backend sh"
    echo "  ./docker-scripts.sh backup_db"
}

# Main script
case "$1" in
    build)
        build
        ;;
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    logs)
        logs "$2"
        ;;
    status)
        status
        ;;
    clean)
        clean
        ;;
    memory)
        memory
        ;;
    health)
        health
        ;;
    backup_db)
        backup_db
        ;;
    restore_db)
        restore_db "$2"
        ;;
    exec_backend)
        shift
        exec_backend "$@"
        ;;
    exec_worker)
        shift
        exec_worker "$@"
        ;;
    help|"")
        help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        help
        exit 1
        ;;
esac
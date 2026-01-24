#!/bin/bash

# Docker management scripts for Travel Guide Backend

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

# Build specific service
build_service() {
    if [ -z "$1" ]; then
        echo -e "${RED}Usage: ./docker-scripts.sh build_service <service_name>${NC}"
        echo -e "${YELLOW}Available services: backend, worker-document, worker-translation${NC}"
        exit 1
    fi
    echo -e "${GREEN}Building $1...${NC}"
    $DOCKER_COMPOSE build --no-cache "$1"
}

# Start all services
start() {
    echo -e "${GREEN}Starting all services...${NC}"
    $DOCKER_COMPOSE up -d
    echo -e "${GREEN}Services started!${NC}"
    echo ""
    echo -e "${BLUE}Running services:${NC}"
    echo -e "  • Backend API: http://localhost:4000"
    echo -e "  • PostgreSQL: localhost:5432"
    echo -e "  • Redis: localhost:6379"
    echo -e "  • LibreTranslate: http://localhost:5000"
    echo -e "  • Document Worker: running in background"
    echo -e "  • Translation Worker: running in background"
    echo ""
    echo -e "${YELLOW}View logs: ./docker-scripts.sh logs${NC}"
    echo -e "${YELLOW}Check health: ./docker-scripts.sh health${NC}"
}

# Start specific service
start_service() {
    if [ -z "$1" ]; then
        echo -e "${RED}Usage: ./docker-scripts.sh start_service <service_name>${NC}"
        exit 1
    fi
    echo -e "${GREEN}Starting $1...${NC}"
    $DOCKER_COMPOSE up -d "$1"
}

# Stop all services
stop() {
    echo -e "${YELLOW}Stopping all services...${NC}"
    $DOCKER_COMPOSE down
    echo -e "${GREEN}Services stopped!${NC}"
}

# Stop specific service
stop_service() {
    if [ -z "$1" ]; then
        echo -e "${RED}Usage: ./docker-scripts.sh stop_service <service_name>${NC}"
        exit 1
    fi
    echo -e "${YELLOW}Stopping $1...${NC}"
    $DOCKER_COMPOSE stop "$1"
}

# Restart all services
restart() {
    echo -e "${YELLOW}Restarting services...${NC}"
    $DOCKER_COMPOSE restart
}

# Restart specific service
restart_service() {
    if [ -z "$1" ]; then
        echo -e "${RED}Usage: ./docker-scripts.sh restart_service <service_name>${NC}"
        exit 1
    fi
    echo -e "${YELLOW}Restarting $1...${NC}"
    $DOCKER_COMPOSE restart "$1"
}

# View logs
logs() {
    if [ -z "$1" ]; then
        $DOCKER_COMPOSE logs -f
    else
        $DOCKER_COMPOSE logs -f "$1"
    fi
}

# View worker logs (both workers)
logs_workers() {
    echo -e "${GREEN}Showing logs for both workers...${NC}"
    $DOCKER_COMPOSE logs -f worker-document worker-translation
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

# Execute command in document worker container
exec_worker_doc() {
    $DOCKER_COMPOSE exec worker-document "$@"
}

# Execute command in translation worker container
exec_worker_trans() {
    $DOCKER_COMPOSE exec worker-translation "$@"
}

# Show memory usage
memory() {
    echo -e "${GREEN}Container Memory Usage:${NC}"
    docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"
}

# Continuous memory monitoring
memory_watch() {
    echo -e "${GREEN}Watching container memory usage (Ctrl+C to stop)...${NC}"
    docker stats --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"
}

# Health check
health() {
    echo -e "${GREEN}Service Health Status:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    services=("postgres" "redis" "libretranslate" "backend" "worker-document" "worker-translation")
    container_names=("travel-postgres" "travel-redis" "libretranslate" "travel-backend" "travel-worker-document" "travel-worker-translation")
    
    for i in "${!services[@]}"; do
        service="${services[$i]}"
        container="${container_names[$i]}"
        
        status=$($DOCKER_COMPOSE ps -q "$service" 2>/dev/null)
        if [ -n "$status" ]; then
            health=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "no healthcheck")
            if [ "$health" == "healthy" ]; then
                echo -e "✅ $service: ${GREEN}$health${NC}"
            elif [ "$health" == "no healthcheck" ]; then
                state=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null)
                if [ "$state" == "running" ]; then
                    echo -e "🟢 $service: ${GREEN}running${NC}"
                else
                    echo -e "⚠️  $service: ${YELLOW}$state${NC}"
                fi
            else
                echo -e "⚠️  $service: ${YELLOW}$health${NC}"
            fi
        else
            echo -e "❌ $service: ${RED}not running${NC}"
        fi
    done
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Check queue status
queue_status() {
    echo -e "${GREEN}Checking BullMQ queue status...${NC}"
    echo -e "${YELLOW}This requires the backend to be running${NC}"
    echo ""
    
    # Check if backend is running
    if ! $DOCKER_COMPOSE ps backend | grep -q "Up"; then
        echo -e "${RED}Backend is not running. Start it first with: ./docker-scripts.sh start${NC}"
        exit 1
    fi
    
    # Make API call to check queue metrics
    response=$(curl -s http://localhost:4000/api/books/queue/metrics 2>/dev/null)
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Queue Metrics:${NC}"
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        echo -e "${RED}Failed to fetch queue metrics. Is the backend API running?${NC}"
    fi
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

# View Redis cache stats
redis_stats() {
    echo -e "${GREEN}Redis Cache Statistics:${NC}"
    $DOCKER_COMPOSE exec redis redis-cli INFO memory | grep -E "used_memory_human|used_memory_peak_human|maxmemory_human"
    echo ""
    echo -e "${GREEN}Redis Keys:${NC}"
    $DOCKER_COMPOSE exec redis redis-cli DBSIZE
}

# Clear Redis cache
redis_clear() {
    echo -e "${YELLOW}This will clear all Redis cache. Are you sure? (y/N)${NC}"
    read -r response
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        $DOCKER_COMPOSE exec redis redis-cli FLUSHALL
        echo -e "${GREEN}Redis cache cleared!${NC}"
    else
        echo -e "${YELLOW}Operation cancelled.${NC}"
    fi
}

# Show help
help() {
    echo -e "${GREEN}Travel Guide Backend - Docker Management Scripts${NC}"
    echo -e "${YELLOW}Using: $DOCKER_COMPOSE${NC}"
    echo ""
    echo "Usage: ./docker-scripts.sh [command] [options]"
    echo ""
    echo -e "${BLUE}Build Commands:${NC}"
    echo "  build                    - Build all Docker images"
    echo "  build_service <name>     - Build specific service"
    echo ""
    echo -e "${BLUE}Service Management:${NC}"
    echo "  start                    - Start all services"
    echo "  start_service <name>     - Start specific service"
    echo "  stop                     - Stop all services"
    echo "  stop_service <name>      - Stop specific service"
    echo "  restart                  - Restart all services"
    echo "  restart_service <name>   - Restart specific service"
    echo "  status                   - Show service status"
    echo ""
    echo -e "${BLUE}Monitoring:${NC}"
    echo "  logs [service]           - View logs (optionally for specific service)"
    echo "  logs_workers             - View both worker logs"
    echo "  health                   - Check health status of all services"
    echo "  memory                   - Show memory usage snapshot"
    echo "  memory_watch             - Continuous memory monitoring"
    echo "  queue_status             - Check BullMQ queue metrics"
    echo ""
    echo -e "${BLUE}Database:${NC}"
    echo "  backup_db                - Create database backup"
    echo "  restore_db <file>        - Restore database from backup"
    echo ""
    echo -e "${BLUE}Redis:${NC}"
    echo "  redis_stats              - Show Redis memory stats"
    echo "  redis_clear              - Clear Redis cache"
    echo ""
    echo -e "${BLUE}Container Access:${NC}"
    echo "  exec_backend <cmd>       - Execute command in backend container"
    echo "  exec_worker_doc <cmd>    - Execute command in document worker"
    echo "  exec_worker_trans <cmd>  - Execute command in translation worker"
    echo ""
    echo -e "${BLUE}Cleanup:${NC}"
    echo "  clean                    - Remove all containers, volumes, and images"
    echo ""
    echo -e "${BLUE}Help:${NC}"
    echo "  help                     - Show this help message"
    echo ""
    echo -e "${GREEN}Examples:${NC}"
    echo "  ./docker-scripts.sh start"
    echo "  ./docker-scripts.sh logs backend"
    echo "  ./docker-scripts.sh logs_workers"
    echo "  ./docker-scripts.sh health"
    echo "  ./docker-scripts.sh queue_status"
    echo "  ./docker-scripts.sh exec_backend sh"
    echo "  ./docker-scripts.sh restart_service worker-translation"
    echo ""
    echo -e "${YELLOW}Services available:${NC}"
    echo "  • backend              - Main NestJS API"
    echo "  • worker-document      - Document generation worker"
    echo "  • worker-translation   - Document translation worker"
    echo "  • postgres             - PostgreSQL database"
    echo "  • redis                - Redis cache/queue"
    echo "  • libretranslate       - Translation service"
}

# Main script
case "$1" in
    build)
        build
        ;;
    build_service)
        build_service "$2"
        ;;
    start)
        start
        ;;
    start_service)
        start_service "$2"
        ;;
    stop)
        stop
        ;;
    stop_service)
        stop_service "$2"
        ;;
    restart)
        restart
        ;;
    restart_service)
        restart_service "$2"
        ;;
    logs)
        logs "$2"
        ;;
    logs_workers)
        logs_workers
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
    memory_watch)
        memory_watch
        ;;
    health)
        health
        ;;
    queue_status)
        queue_status
        ;;
    backup_db)
        backup_db
        ;;
    restore_db)
        restore_db "$2"
        ;;
    redis_stats)
        redis_stats
        ;;
    redis_clear)
        redis_clear
        ;;
    exec_backend)
        shift
        exec_backend "$@"
        ;;
    exec_worker_doc)
        shift
        exec_worker_doc "$@"
        ;;
    exec_worker_trans)
        shift
        exec_worker_trans "$@"
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
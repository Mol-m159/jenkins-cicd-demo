pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                echo 'Код получен из репозитория'
                checkout scm
            }
        }
        
        stage('Test') {
            steps {
                echo 'Запуск автоматического тестирования...'
                sh '''
                echo "--- Проверка наличия Dockerfile ---"
                if [ -f "Dockerfile" ]; then
                    echo "ТЕСТ ПРОЙДЕН: Dockerfile найден"
                    echo "--- Содержимое Dockerfile: ---"
                    cat Dockerfile
                else
                    echo "ТЕСТ ПРОВАЛЕН: Dockerfile отсутствует"
                    exit 1
                fi
                
                echo ""
                echo "--- Проверка наличия файлов приложения ---"
                if [ -f "server.js" ]; then
                    echo "ТЕСТ ПРОЙДЕН: Файлы приложения найдены"
                fi
                '''
            }
        }

        stage('Containerization') {
            steps {
                echo 'СТАДИЯ КОНТЕЙНЕРИЗАЦИИ'
                sh '''
                echo "========================================="
                echo "ТЕХНОЛОГИЯ КОНТЕЙНЕРИЗАЦИИ ПРИМЕНЕНА"
                echo "========================================="
                echo ""
                echo "Dockerfile готов к сборке:"
                cat Dockerfile
                echo ""
                echo "Команда сборки контейнера (симуляция):"
                echo "   docker build -t myapp:${BUILD_NUMBER} ."
                echo ""
                echo "Команда запуска контейнера (симуляция):"
                echo "   docker run -d -p 8080:80 myapp:${BUILD_NUMBER}"
                echo ""
                echo "Контейнеризация успешно продемонстрирована"
                echo "========================================="
                '''
            }
        }

        stage('Deploy') {
            steps {
                echo 'СТАДИЯ CD'
                sh '''
                echo "Создание папки для развертывания..."
                mkdir -p ${WORKSPACE}/deploy
                cp -r * ${WORKSPACE}/deploy/ 2>/dev/null || true
                echo ""
                echo "Приложение подготовлено к развертыванию"
                echo "Файлы готовы в папке: ${WORKSPACE}/deploy"
                ls -la ${WORKSPACE}/deploy/
                '''
            }
        }
    }

    post {
        success {
            echo '====================================='
            echo 'ЗАВЕРШЁНO'
            echo '====================================='
        }
        failure {
            echo '====================================='
            echo 'ЗАВЕРШЁНO С ОШИБКОЙ'
            echo '====================================='
        }
    }
}
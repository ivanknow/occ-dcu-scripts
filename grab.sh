#!/bin/bash

# load config file
. ./dcu.conf

# read arguments
for i in "$@"
do
case $i in
    -e=*|--env=*)
        env="${i#*=}"
        shift
    ;;
esac
done

# validate arguments
invalid_param="The following parameters are required:\n--env=test|stage|prod OR -e"
[ -z "$env" ] && echo -e $invalid_param && exit 0

echo "Grabbing from environment $env..."

case $env in
    "test")
        mkdir -p src/test
        dcu -g -c -n https://ccadmin-test-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/test -k $TEST_APP_KEY
    ;;
    "stage")
        mkdir -p src/stage
        dcu -g -c -n https://ccadmin-stage-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/stage -k $STAGE_APP_KEY
    ;;
    "prod")
        mkdir -p src/prod
        dcu -g -c -n https://ccadmin-prod-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/prod -k $PROD_APP_KEY
    ;;
esac

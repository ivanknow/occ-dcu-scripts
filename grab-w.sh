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
    -w=*|--widget=*)
        widget="${i#*=}"
        shift
    ;;
esac
done

# validate arguments
invalid_param="The following parameters are required:\n--env=test|stage|prod OR -e\n--widget=widget/name OR -w"
full_grab_required="\nYou must perform a full grab with grab.sh before grabbing a single widget."
[ -z "$env" ] && echo -e $invalid_param && exit 0
[ -z "$widget" ] && echo -e $invalid_param && exit 0

echo "Grabbing from environment $env..."

case $env in
    "test")
        if [ ! -d "src/test" ]; then
            echo -e $full_grab_required
            exit
        fi
        dcu --refresh "$widget" -n https://ccadmin-test-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/test -k $TEST_APP_KEY
    ;;
    "stage")
        if [ ! -d "src/test" ]; then
            echo -e $full_grab_required
            exit
        fi
        dcu --refresh "$widget" -n https://ccadmin-stage-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/stage -k $STAGE_APP_KEY
    ;;
    "prod")
        if [ ! -d "src/prod" ]; then
            echo -e $full_grab_required
            exit
        fi
        dcu --refresh "$widget" -n https://ccadmin-prod-$ENVIRONMENT_ID.oracleoutsourcing.com -b src/prod -k $PROD_APP_KEY
    ;;
esac
